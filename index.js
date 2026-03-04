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
 * Dispatch a Todoist webhook event to the appropriate sync action.
 *
 * @param {string} eventName
 * @param {object} task  The event_data payload from Todoist
 */
async function handleTodoistEvent(eventName, task) {
  if (!task || !task.id) {
    console.warn(`[webhook] event_data missing or has no id for event: ${eventName}`);
    return;
  }

  const todoistId = String(task.id);

  // If this task ID was last written by our own Notion→Todoist sync and is
  // still within the debounce window, skip it to prevent an echo loop.
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
          // We haven't seen this task before — treat it like a new task
          console.log(
            `[webhook] item:updated but no mapping found — creating Notion page for task id=${todoistId}`
          );
          await notionSync.createNotionPage(task);
        } else {
          console.log(
            `[webhook] item:updated → updating Notion page id=${record.notion_id}`
          );
          await notionSync.updateNotionPage(record.notion_id, task);
        }
        break;
      }

      case 'item:completed': {
        const record = store.getByTodoistId(todoistId);
        if (!record) {
          console.warn(
            `[webhook] item:completed but no Notion page mapping found for task id=${todoistId}`
          );
          return;
        }

        // Recurring tasks are never truly "done" — completing one occurrence
        // advances the due date to the next.  Todoist will fire item:updated
        // immediately after with the new due date, which will update Notion.
        // Marking the page done here would incorrectly close it.
        if (task.due?.is_recurring) {
          console.log(
            `[webhook] item:completed for recurring task id=${todoistId} — ` +
              'skipping done mark; item:updated will follow with the next due date'
          );
          break;
        }

        console.log(
          `[webhook] item:completed → marking Notion page done id=${record.notion_id}`
        );
        await notionSync.markNotionDone(record.notion_id);
        break;
      }

      case 'item:deleted': {
        const record = store.getByTodoistId(todoistId);
        if (!record) {
          console.warn(
            `[webhook] item:deleted but no Notion page mapping found for task id=${todoistId}`
          );
          return;
        }
        console.log(
          `[webhook] item:deleted → archiving Notion page id=${record.notion_id}`
        );
        await notionSync.archiveNotionPage(record.notion_id);
        break;
      }

      default:
        console.log(`[webhook] Unhandled event type: ${eventName} — ignoring`);
    }
  } catch (err) {
    console.error(
      `[webhook] Error handling ${eventName} for task id=${todoistId}:`,
      err.response?.data ?? err.message
    );
  }
}

// ---------------------------------------------------------------------------
// Bidirectional sync cron — every 60 seconds
// ---------------------------------------------------------------------------

// Notion → Todoist: track pages modified since this timestamp
let lastPollTime =
  store.getLastPollTime() ?? new Date(Date.now() - 60_000).toISOString();

// Todoist → Notion: Sync API token ('*' = full sync on first run)
let todoistSyncToken = store.getTodoistSyncToken() ?? '*';

console.log(`[cron] Initialising sync. Notion lastPollTime=${lastPollTime}, Todoist syncToken=${todoistSyncToken === '*' ? 'FULL' : 'incremental'}`);

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

  // ── Todoist → Notion ──────────────────────────────────────────────────────
  try {
    const newSyncToken = await notionSync.pollTodoist(todoistSyncToken);
    todoistSyncToken = newSyncToken;
    store.setTodoistSyncToken(todoistSyncToken);
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
  const { Client } = require('@notionhq/client');
  const notionClient = new Client({ auth: process.env.NOTION_API_KEY });

  // 1. Verify the Notion integration can reach the target database.
  try {
    const db = await notionClient.databases.retrieve({
      database_id: process.env.NOTION_DATABASE_ID,
    });
    console.log(
      `[startup] Notion database OK — "${db.title?.[0]?.plain_text ?? db.id}"`
    );

    // Warn if any expected properties are missing.
    const required = ['Name', 'Due', 'Priority', 'Done', 'TodoistID'];
    const present = Object.keys(db.properties);
    const missing = required.filter((p) => !present.includes(p));
    if (missing.length > 0) {
      console.warn(
        `[startup] WARNING — Notion database is missing expected properties: ${missing.join(', ')}. ` +
          'Sync will fail until these are added. See README for the required schema.'
      );
    }
  } catch (err) {
    const hint =
      err.code === 'object_not_found'
        ? 'Check that NOTION_DATABASE_ID is correct and the integration has been added as a Connection to the database.'
        : err.code === 'unauthorized'
        ? 'Check that NOTION_API_KEY is correct and the integration exists.'
        : err.message;
    console.error(`[startup] ERROR — Cannot reach Notion database: ${hint}`);
  }

  // Todoist token is validated implicitly on the first write operation
  // (task create/update/close). The REST v2 GET endpoints return 410 in some
  // account configurations, so a read-based health check is unreliable.
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
