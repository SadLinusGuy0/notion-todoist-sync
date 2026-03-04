'use strict';

const { Client } = require('@notionhq/client');
const axios = require('axios');
const store = require('./store');
const { notionPageToTodoistTask, todoistTaskToNotionProps, hashTodoistTask } = require('./fieldMap');
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
// Todoist polling loop (REST API with hash-based change detection)
// ---------------------------------------------------------------------------

/**
 * Fetch every active task from the Todoist REST API, handling cursor
 * pagination.  Returns a flat array of task objects.
 */
async function fetchAllTodoistTasks() {
  const tasks = [];
  let cursor = null;

  do {
    const params = { limit: 200 };
    if (cursor) params.cursor = cursor;

    const response = await axios.get('https://api.todoist.com/api/v1/tasks', {
      headers: { Authorization: `Bearer ${process.env.TODOIST_API_TOKEN}` },
      params,
    });

    const body = response.data;
    const page = Array.isArray(body) ? body : (body.results ?? body.items ?? []);
    tasks.push(...page);
    cursor = body.next_cursor ?? null;
  } while (cursor);

  return tasks;
}

/**
 * Poll Todoist for all active tasks and mirror any changes into Notion.
 *
 * Uses a SHA-1 hash of each task's synced fields to detect actual changes.
 * Tasks whose hash matches the stored value are skipped, preventing unnecessary
 * Notion writes and the echo loop that a naive full-fetch would cause.
 *
 * @returns {Promise<void>}
 */
async function pollTodoist() {
  console.log('[todoistPoll] Fetching active tasks from Todoist...');

  let tasks;
  try {
    tasks = await fetchAllTodoistTasks();
  } catch (err) {
    console.error(
      `[todoistPoll] Failed to fetch tasks: ${err.response?.status ?? err.message}. ` +
        'Will retry next cycle.'
    );
    return;
  }

  console.log(`[todoistPoll] Processing ${tasks.length} active task(s)`);
  let created = 0, updated = 0, skipped = 0;

  for (const task of tasks) {
    const todoistId = String(task.id);

    // Skip tasks recently written by our own Notion→Todoist sync (echo prevention)
    if (store.isDebounced(todoistId)) {
      skipped++;
      continue;
    }

    const existing = store.getByTodoistId(todoistId);
    const newHash = hashTodoistTask(task);

    try {
      if (!existing) {
        // Task not yet in Notion — webhook must have been missed
        console.log(
          `[todoistPoll] New task id=${todoistId} "${task.content}" → creating Notion page`
        );
        await createNotionPage(task);
        store.setTaskHash(todoistId, newHash);
        created++;
      } else if (existing.task_hash !== newHash) {
        // One or more synced fields changed since last write
        console.log(
          `[todoistPoll] Task id=${todoistId} changed → updating Notion page id=${existing.notion_id}`
        );
        await updateNotionPage(existing.notion_id, task);
        store.markSynced(todoistId, 'todoist');
        store.setTaskHash(todoistId, newHash);
        updated++;
      } else {
        skipped++;
      }
    } catch (err) {
      console.error(
        `[todoistPoll] Failed to sync task id=${todoistId}:`,
        err.response?.data ?? err.message
      );
    }
  }

  console.log(
    `[todoistPoll] Done — ${created} created, ${updated} updated, ${skipped} unchanged/debounced`
  );
}

module.exports = {
  createNotionPage,
  updateNotionPage,
  archiveNotionPage,
  markNotionDone,
  pollNotion,
  pollTodoist,
};
