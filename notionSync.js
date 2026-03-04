'use strict';

const { Client } = require('@notionhq/client');
const axios = require('axios');
const store = require('./store');
const { notionPageToTodoistTask, todoistTaskToNotionProps } = require('./fieldMap');
const todoistSync = require('./todoistSync');
const projectCache = require('./projectCache');

// Client is created lazily so that the env var is always read at call time,
// and so that a bad key produces a clear error at the first API call rather
// than a silent failure at module load.
let _notion = null;
function notion() {
  if (!_notion) {
    _notion = new Client({ auth: process.env.NOTION_API_KEY });
  }
  return _notion;
}

function dbId() {
  return process.env.NOTION_DATABASE_ID;
}

/**
 * Returns true when a Notion API error indicates the page is archived and
 * cannot be edited.  In that case callers should treat the operation as a
 * safe no-op rather than surfacing an error.
 */
function isArchivedError(err) {
  return (
    err?.code === 'validation_error' &&
    typeof err?.message === 'string' &&
    err.message.includes('archived')
  );
}

// ---------------------------------------------------------------------------
// Write helpers (Notion side)
// ---------------------------------------------------------------------------

/**
 * Create a new Notion page in the configured database from a Todoist task.
 *
 * @param {object} task  Raw Todoist task object
 * @returns {Promise<object>}  The created Notion page object
 */
async function createNotionPage(task) {
  console.log(`[notionSync] Creating page for todoist task id=${task.id} "${task.content}"`);

  const projectName = await projectCache.getProjectName(task.project_id);
  const properties = todoistTaskToNotionProps(task, task.id, projectName);

  const page = await notion().pages.create({
    parent: { database_id: dbId() },
    properties,
  });

  console.log(`[notionSync] Created page id=${page.id} for todoist_id=${task.id}`);

  // Persist mapping; origin=todoist so the poll loop debounces it.
  store.upsert(String(task.id), page.id, 'todoist');

  return page;
}

/**
 * Update an existing Notion page's properties from a Todoist task.
 *
 * @param {string} notionId
 * @param {object} task  Raw Todoist task object
 * @returns {Promise<object>}  The updated Notion page object
 */
async function updateNotionPage(notionId, task) {
  console.log(`[notionSync] Updating page id=${notionId} from todoist_id=${task.id}`);

  const projectName = await projectCache.getProjectName(task.project_id);
  const properties = todoistTaskToNotionProps(task, task.id, projectName);

  try {
    const page = await notion().pages.update({
      page_id: notionId,
      properties,
    });

    store.markSynced(notionId, 'todoist');
    console.log(`[notionSync] Updated page id=${notionId}`);
    return page;
  } catch (err) {
    if (isArchivedError(err)) {
      console.log(
        `[notionSync] Page id=${notionId} is archived — skipping update.`
      );
      return null;
    }
    throw err;
  }
}

/**
 * Archive (soft-delete) a Notion page.
 *
 * @param {string} notionId
 * @returns {Promise<object>}
 */
async function archiveNotionPage(notionId) {
  console.log(`[notionSync] Archiving page id=${notionId}`);

  const page = await notion().pages.update({
    page_id: notionId,
    archived: true,
  });

  store.markSynced(notionId, 'todoist');
  console.log(`[notionSync] Archived page id=${notionId}`);

  return page;
}

/**
 * Mark a Notion page's Done checkbox as true.
 *
 * @param {string} notionId
 * @returns {Promise<object>}
 */
async function markNotionDone(notionId) {
  console.log(`[notionSync] Marking page done id=${notionId}`);

  try {
    const page = await notion().pages.update({
      page_id: notionId,
      properties: {
        Done: { checkbox: true },
      },
    });

    store.markSynced(notionId, 'todoist');
    console.log(`[notionSync] Marked done page id=${notionId}`);
    return page;
  } catch (err) {
    if (isArchivedError(err)) {
      console.log(
        `[notionSync] Page id=${notionId} is already archived — treating as done, skipping write.`
      );
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Polling loop
// ---------------------------------------------------------------------------

/**
 * Query Notion for pages modified since `lastPollTime`, then create or update
 * the corresponding Todoist tasks.  Pages that were recently written by the
 * Todoist webhook handler are skipped (debounce window).
 *
 * @param {string} lastPollTime  ISO 8601 timestamp
 * @returns {Promise<string>}    ISO 8601 timestamp to use as the next lastPollTime
 */
async function pollNotion(lastPollTime) {
  const pollStart = new Date().toISOString();
  console.log(`[notionSync] Polling Notion for pages modified since ${lastPollTime}`);

  let pages = [];

  try {
    // Notion filter: last_edited_time is an implicit filter via after
    const response = await notion().databases.query({
      database_id: dbId(),
      filter: {
        timestamp: 'last_edited_time',
        last_edited_time: {
          after: lastPollTime,
        },
      },
      // Fetch up to 100 at a time; add cursor pagination if needed
      page_size: 100,
    });

    pages = response.results;
  } catch (err) {
    console.error('[notionSync] Failed to query Notion database:', err.message);
    return lastPollTime;
  }

  console.log(`[notionSync] Found ${pages.length} changed page(s)`);

  for (const page of pages) {
    const notionId = page.id;

    // Skip pages that were last written by our Todoist webhook handler within
    // the debounce window to prevent echo loops.
    if (store.isDebounced(notionId)) {
      console.log(`[notionSync] Skipping debounced page id=${notionId}`);
      continue;
    }

    let fields;
    try {
      fields = notionPageToTodoistTask(page);
    } catch (err) {
      console.error(`[notionSync] Failed to map page id=${notionId}:`, err.message);
      continue;
    }

    const existing = store.getByNotionId(notionId);

    try {
      if (!existing) {
        // New page — create a matching Todoist task
        const task = await todoistSync.createTodoistTask(fields, notionId);

        // Write the Todoist ID back into the Notion page so future lookups work
        await notion().pages.update({
          page_id: notionId,
          properties: {
            TodoistID: {
              rich_text: [
                { type: 'text', text: { content: String(task.id) } },
              ],
            },
          },
        });

        // Stamp debounce so the next poll doesn't re-process this page
        store.upsert(String(task.id), notionId, 'notion');
        console.log(
          `[notionSync] Created todoist task id=${task.id} for notion page id=${notionId}`
        );
      } else {
        const todoistId = existing.todoist_id;

        if (fields.is_done) {
          // Page marked done — close the Todoist task
          await todoistSync.closeTodoistTask(todoistId);
          store.markSynced(notionId, 'notion');
          console.log(
            `[notionSync] Closed todoist task id=${todoistId} (Notion page marked done)`
          );
        } else {
          // Regular update
          await todoistSync.updateTodoistTask(todoistId, fields, notionId);
          store.markSynced(notionId, 'notion');
        }
      }
    } catch (err) {
      console.error(
        `[notionSync] Failed to sync page id=${notionId}:`,
        err.response?.data ?? err.message
      );
    }
  }

  return pollStart;
}

// ---------------------------------------------------------------------------
// Todoist polling loop (Sync API)
// ---------------------------------------------------------------------------

/**
 * Poll the Todoist Sync API for items changed since `syncToken` and mirror
 * those changes into Notion.  Returns the new sync token to persist for the
 * next call.
 *
 * On first run pass '*' as syncToken — this triggers a full sync that returns
 * every active task.  Subsequent calls with the returned token receive only
 * incremental deltas, keeping API usage minimal.
 *
 * @param {string} syncToken  Previous sync token, or '*' for a full sync
 * @returns {Promise<string>}  New sync token to use on the next call
 */
async function pollTodoist(syncToken) {
  console.log(
    `[todoistPoll] Checking Todoist for changes (full_sync=${syncToken === '*'})...`
  );

  let response;
  try {
    response = await axios.post(
      'https://api.todoist.com/sync/v9/sync',
      { sync_token: syncToken, resource_types: ['items'] },
      {
        headers: {
          Authorization: `Bearer ${process.env.TODOIST_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (err) {
    console.error(
      `[todoistPoll] Sync API request failed: ${err.response?.status ?? err.message}. ` +
        'Will retry next cycle.'
    );
    return syncToken;
  }

  const { items = [], sync_token: newSyncToken, full_sync } = response.data;
  console.log(`[todoistPoll] Received ${items.length} changed item(s)`);

  for (const item of items) {
    const todoistId = String(item.id);

    // Skip items that were recently written by our own Notion→Todoist sync
    // to prevent an echo loop.
    if (store.isDebounced(todoistId)) {
      console.log(`[todoistPoll] Skipping debounced item id=${todoistId}`);
      continue;
    }

    const existing = store.getByTodoistId(todoistId);

    // ── Deleted ──────────────────────────────────────────────────────────────
    if (item.is_deleted) {
      if (existing) {
        console.log(
          `[todoistPoll] Task deleted id=${todoistId} → archiving Notion page id=${existing.notion_id}`
        );
        await archiveNotionPage(existing.notion_id);
        store.markSynced(todoistId, 'todoist');
      }
      continue;
    }

    // Normalise the Sync API item shape to match what the REST API returns so
    // fieldMap and notionSync helpers work without modification.
    const isCompleted = item.checked === true || item.checked === 1;
    const task = { ...item, is_completed: isCompleted };

    // ── Completed ─────────────────────────────────────────────────────────────
    if (isCompleted) {
      if (existing) {
        if (item.due?.is_recurring) {
          // Recurring task: the due date has advanced — update Notion page
          // rather than marking it done.
          console.log(
            `[todoistPoll] Recurring task completed id=${todoistId} → updating Notion due date`
          );
          await updateNotionPage(existing.notion_id, task);
        } else {
          console.log(
            `[todoistPoll] Task completed id=${todoistId} → marking Notion page done`
          );
          await markNotionDone(existing.notion_id);
        }
        store.markSynced(todoistId, 'todoist');
      }
      // Don't create new Notion pages for tasks that are already completed.
      continue;
    }

    // ── Active (new or updated) ───────────────────────────────────────────────
    try {
      if (existing) {
        console.log(
          `[todoistPoll] Updating Notion page id=${existing.notion_id} for task id=${todoistId}`
        );
        await updateNotionPage(existing.notion_id, task);
        store.markSynced(todoistId, 'todoist');
      } else {
        console.log(
          `[todoistPoll] New task id=${todoistId} "${item.content}" → creating Notion page`
        );
        await createNotionPage(task);
      }
    } catch (err) {
      console.error(
        `[todoistPoll] Failed to sync task id=${todoistId}:`,
        err.response?.data ?? err.message
      );
    }
  }

  return newSyncToken;
}

module.exports = {
  createNotionPage,
  updateNotionPage,
  archiveNotionPage,
  markNotionDone,
  pollNotion,
  pollTodoist,
};
