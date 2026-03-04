'use strict';

// Load .env only in local development. On Railway (and other PaaS hosts)
// environment variables are injected directly into the process — no file needed,
// and no .env file should ever be present in a production deployment.
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const express = require('express');
const crypto = require('crypto');
const cron = require('node-cron');
const store = require('./store');
const notionSync = require('./notionSync');
const projectCache = require('./projectCache');

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

const REQUIRED_ENV = [
  'TODOIST_API_TOKEN',
  'NOTION_API_KEY',
  'NOTION_DATABASE_ID',
  'WEBHOOK_SECRET',
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[index] Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Express setup
// ---------------------------------------------------------------------------

const app = express();

// Parse raw body for HMAC validation BEFORE json middleware.
// We store the raw buffer on req so the webhook handler can verify it.
app.use(
  express.json({
    verify(req, _res, buf) {
      req.rawBody = buf;
    },
  })
);

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ---------------------------------------------------------------------------
// HMAC validation helper
// ---------------------------------------------------------------------------

/**
 * Verify the Todoist HMAC-SHA256 webhook signature.
 * Todoist signs the raw request body with the webhook client secret using
 * HMAC-SHA256 and sends the base64-encoded result in X-Todoist-Hmac-SHA256.
 *
 * @param {Buffer} rawBody
 * @param {string} signature  Value of the X-Todoist-Hmac-SHA256 header
 * @returns {boolean}
 */
function isValidTodoistSignature(rawBody, signature) {
  if (!signature) return false;
  const expected = crypto
    .createHmac('sha256', process.env.WEBHOOK_SECRET)
    .update(rawBody)
    .digest('base64');
  try {
    // timingSafeEqual throws if the two buffers have different byte lengths,
    // which would happen if the incoming signature is malformed.
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'utf8'),
      Buffer.from(signature, 'utf8')
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Todoist webhook handler
// ---------------------------------------------------------------------------

app.post('/webhook/todoist', async (req, res) => {
  // Log every inbound request so we can confirm Todoist is actually reaching us.
  console.log(
    `[webhook] Inbound POST /webhook/todoist — has-signature=${!!req.headers['x-todoist-hmac-sha256']}`
  );

  // Validate signature
  const signature = req.headers['x-todoist-hmac-sha256'];
  if (!isValidTodoistSignature(req.rawBody, signature)) {
    console.warn(
      '[webhook] Rejected — HMAC signature invalid. ' +
        'Check that WEBHOOK_SECRET matches the client secret set in the Todoist App Console.'
    );
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const { event_name, event_data } = req.body;
  console.log(`[webhook] Received event: ${event_name} for task id=${event_data?.id}`);

  // Respond quickly so Todoist doesn't time out waiting for us
  res.status(200).json({ received: true });

  // Process asynchronously
  setImmediate(() => handleTodoistEvent(event_name, event_data));
});

/**
 * Top-level dispatcher — routes each Todoist webhook event to the correct
 * handler based on its event name prefix.
 */
async function handleTodoistEvent(eventName, eventData) {
  if (eventName.startsWith('project:')) {
    return handleProjectEvent(eventName, eventData);
  }
  if (eventName.startsWith('label:')) {
    return handleLabelEvent(eventName, eventData);
  }
  return handleItemEvent(eventName, eventData);
}

// ---------------------------------------------------------------------------
// Item event handler
// ---------------------------------------------------------------------------

async function handleItemEvent(eventName, task) {
  if (!task || !task.id) {
    console.warn(`[webhook] event_data missing or has no id for event: ${eventName}`);
    return;
  }

  const todoistId = String(task.id);

  // Skip events triggered by our own Notion→Todoist writes (echo prevention).
  const existing = store.getByTodoistId(todoistId);
  if (existing && existing.origin === 'notion' && store.isDebounced(todoistId)) {
    console.log(
      `[webhook] Skipping debounced echo for todoist_id=${todoistId} (origin=notion)`
    );
    return;
  }

  try {
    switch (eventName) {
      case 'item:added': {
        console.log(`[webhook] item:added → creating Notion page for task id=${todoistId}`);
        await notionSync.createNotionPage(task);
        break;
      }

      case 'item:updated': {
        const record = store.getByTodoistId(todoistId);
        if (!record) {
          console.log(
            `[webhook] item:updated — no mapping found, creating Notion page for task id=${todoistId}`
          );
          await notionSync.createNotionPage(task);
        } else {
          console.log(`[webhook] item:updated → updating Notion page id=${record.notion_id}`);
          await notionSync.updateNotionPage(record.notion_id, task);
        }
        break;
      }

      case 'item:completed': {
        const record = store.getByTodoistId(todoistId);
        if (!record) {
          console.warn(`[webhook] item:completed — no Notion mapping for task id=${todoistId}`);
          return;
        }
        // Recurring tasks: completing one occurrence advances the due date.
        // item:updated fires immediately after with the new date — let that
        // handle Notion; don't mark the page done here.
        if (task.due?.is_recurring) {
          console.log(
            `[webhook] item:completed (recurring) id=${todoistId} — ` +
              'skipping done mark; item:updated will follow with new due date'
          );
          break;
        }
        console.log(`[webhook] item:completed → marking Notion page done id=${record.notion_id}`);
        await notionSync.markNotionDone(record.notion_id);
        break;
      }

      case 'item:uncompleted': {
        const record = store.getByTodoistId(todoistId);
        if (!record) {
          // Task existed before sync started — create a fresh Notion page.
          console.log(
            `[webhook] item:uncompleted — no mapping found, creating Notion page for task id=${todoistId}`
          );
          await notionSync.createNotionPage(task);
        } else {
          console.log(
            `[webhook] item:uncompleted → updating Notion page id=${record.notion_id} (Done=false)`
          );
          await notionSync.updateNotionPage(record.notion_id, task);
        }
        break;
      }

      case 'item:deleted': {
        const record = store.getByTodoistId(todoistId);
        if (!record) {
          console.warn(`[webhook] item:deleted — no Notion mapping for task id=${todoistId}`);
          return;
        }
        console.log(`[webhook] item:deleted → archiving Notion page id=${record.notion_id}`);
        await notionSync.archiveNotionPage(record.notion_id);
        break;
      }

      default:
        console.log(`[webhook] Unhandled item event: ${eventName}`);
    }
  } catch (err) {
    console.error(
      `[webhook] Error handling ${eventName} for task id=${todoistId}:`,
      err.response?.data ?? err.message
    );
  }
}

// ---------------------------------------------------------------------------
// Project event handler
// ---------------------------------------------------------------------------

async function handleProjectEvent(eventName, project) {
  console.log(`[webhook] ${eventName} id=${project?.id} "${project?.name ?? ''}"`);

  switch (eventName) {
    case 'project:added':
    case 'project:updated': {
      // Refresh the cache so subsequent task syncs use the new/renamed name.
      await projectCache.refreshCache();
      console.log(`[webhook] ${eventName} — project cache refreshed`);
      break;
    }

    case 'project:deleted':
    case 'project:archived': {
      // Tasks in a deleted/archived project will arrive as item:deleted events.
      // Just keep the cache fresh so stale names don't linger.
      await projectCache.refreshCache();
      console.log(`[webhook] ${eventName} — project cache refreshed`);
      break;
    }

    default:
      console.log(`[webhook] Unhandled project event: ${eventName}`);
  }
}

// ---------------------------------------------------------------------------
// Label event handler
// ---------------------------------------------------------------------------

async function handleLabelEvent(eventName, label) {
  console.log(`[webhook] ${eventName} id=${label?.id} "${label?.name ?? ''}"`);

  switch (eventName) {
    case 'label:added': {
      // New label — no pages to update yet.  Tasks that get this label will
      // arrive via item:updated and the Labels multi-select will be set then.
      console.log(`[webhook] label:added — no immediate action needed`);
      break;
    }

    case 'label:updated':
    case 'label:deleted': {
      // The next Todoist poll fetches all tasks with their current label arrays.
      // Any task whose labels changed will have a different hash and its Notion
      // page will be updated automatically — no manual reset needed.
      console.log(
        `[webhook] ${eventName} — affected task labels will update on the next poll cycle`
      );
      break;
    }

    default:
      console.log(`[webhook] Unhandled label event: ${eventName}`);
  }
}

// ---------------------------------------------------------------------------
// Bidirectional sync cron — every 60 seconds
// ---------------------------------------------------------------------------

// Notion → Todoist: track pages modified since this timestamp
let lastPollTime =
  store.getLastPollTime() ?? new Date(Date.now() - 60_000).toISOString();

console.log(`[cron] Initialising sync. Notion lastPollTime=${lastPollTime}`);

cron.schedule('*/1 * * * *', async () => {
  console.log('[cron] Starting bidirectional sync cycle');

  // ── Notion → Todoist ──────────────────────────────────────────────────────
  try {
    const newPollTime = await notionSync.pollNotion(lastPollTime);
    lastPollTime = newPollTime;
    store.setLastPollTime(lastPollTime);
  } catch (err) {
    console.error('[cron] Notion poll error:', err.message);
  }

  // ── Todoist → Notion (hash-based, skips unchanged tasks) ──────────────────
  try {
    await notionSync.pollTodoist();
  } catch (err) {
    console.error('[cron] Todoist poll error:', err.message);
  }

  console.log('[cron] Sync cycle complete');
});

// ---------------------------------------------------------------------------
// One-time import endpoints
// ---------------------------------------------------------------------------

/**
 * POST /import/todoist
 * Fetches every active task from Todoist and creates a Notion page for any
 * task that is not already mapped in the sync store.  Safe to call multiple
 * times — already-mapped tasks are skipped.
 */
app.post('/import/todoist', (req, res) => {
  res.json({
    status: 'started',
    message: 'Todoist → Notion import running in background — watch logs for progress.',
  });
  setImmediate(importFromTodoist);
});

async function importFromTodoist() {
  console.log('[import] Starting Todoist → Notion bulk import...');
  const axios = require('axios');

  // The /api/v1/tasks endpoint is paginated via cursor.  Collect all pages.
  const tasks = [];
  let cursor = null;

  try {
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
  } catch (err) {
    console.error(
      `[import] Could not fetch tasks from Todoist: HTTP ${err.response?.status ?? err.message}.`
    );
    return;
  }

  console.log(`[import] Fetched ${tasks.length} active Todoist task(s)`);
  let created = 0;
  let skipped = 0;

  for (const task of tasks) {
    const existing = store.getByTodoistId(String(task.id));
    if (existing) {
      skipped++;
      continue;
    }
    try {
      await notionSync.createNotionPage(task);
      created++;
    } catch (err) {
      console.error(
        `[import] Failed to create Notion page for task id=${task.id} "${task.content}":`,
        err.message
      );
    }
  }

  console.log(
    `[import] Todoist → Notion import complete: ${created} created, ${skipped} already mapped.`
  );
}

/**
 * POST /import/notion
 * Resets the Notion poll cursor to a date far in the past so the very next
 * cron tick (within 60 s) picks up every page in the database regardless of
 * when it was last edited.  Already-mapped pages are updated; unmapped pages
 * get a new Todoist task created.  Safe to call multiple times.
 */
app.post('/import/notion', (req, res) => {
  lastPollTime = '2000-01-01T00:00:00.000Z';
  store.setLastPollTime(lastPollTime);
  console.log('[import] Notion poll cursor reset to 2000-01-01 — all pages will be imported on next cron tick.');
  res.json({
    status: 'scheduled',
    message: 'Notion → Todoist import will run on the next poll cycle (within 60 s) — watch logs.',
  });
});

// ---------------------------------------------------------------------------
// Startup connectivity checks
// ---------------------------------------------------------------------------

async function runStartupChecks() {
  const { refreshSchema } = require('./notionSchema');

  // 1. Fetch the Notion database schema (this also warms the filterProps cache
  //    so the first webhook/poll call doesn't need to do an extra round-trip).
  try {
    const { props, title } = await refreshSchema();
    console.log(`[startup] Notion database OK — "${title}"`);

    // Warn about required properties that are absent.
    const required = ['Name', 'Due', 'Priority', 'Done', 'TodoistID'];
    const missingRequired = required.filter((p) => !props.has(p));
    if (missingRequired.length > 0) {
      console.warn(
        `[startup] WARNING — missing required properties: ${missingRequired.join(', ')}. ` +
          'Core sync will not work until these are added. See README for schema.'
      );
    }

    // Inform about optional properties that will be skipped until added.
    const optional = ['Labels', 'Project', 'Recurring', 'Recurrence', 'Status'];
    const missingOptional = optional.filter((p) => !props.has(p));
    if (missingOptional.length > 0) {
      console.log(
        `[startup] NOTE — optional properties not found in database (will be skipped until added): ` +
          missingOptional.join(', ')
      );
    }
  } catch (err) {
    const hint =
      err.code === 'object_not_found'
        ? 'Check that NOTION_DATABASE_ID is correct and the integration has been added as a Connection.'
        : err.code === 'unauthorized'
        ? 'Check that NOTION_API_KEY is correct and the integration exists.'
        : err.message;
    console.error(`[startup] ERROR — Cannot reach Notion database: ${hint}`);
  }

  // Todoist token is validated implicitly on the first write operation.
  console.log(
    '[startup] Todoist token present — will be validated on first sync operation.'
  );
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[index] notion-todoist-sync running on port ${PORT}`);
  console.log(`[index] Webhook endpoint: POST http://localhost:${PORT}/webhook/todoist`);
  console.log(`[index] Health check:     GET  http://localhost:${PORT}/health`);
  runStartupChecks();
});
