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
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// ---------------------------------------------------------------------------
// Todoist webhook handler
// ---------------------------------------------------------------------------

app.post('/webhook/todoist', async (req, res) => {
  // Validate signature
  const signature = req.headers['x-todoist-hmac-sha256'];
  if (!isValidTodoistSignature(req.rawBody, signature)) {
    console.warn('[webhook] Rejected request with invalid HMAC signature');
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
// Notion polling cron job — every 60 seconds
// ---------------------------------------------------------------------------

// Initialise last poll time to now on startup so we don't reprocess all
// historical pages on the first run.
let lastPollTime =
  store.getLastPollTime() ?? new Date(Date.now() - 60_000).toISOString();

console.log(`[cron] Initialising Notion poll. Last poll time: ${lastPollTime}`);

cron.schedule('*/1 * * * *', async () => {
  console.log('[cron] Starting Notion poll cycle');
  try {
    const newPollTime = await notionSync.pollNotion(lastPollTime);
    lastPollTime = newPollTime;
    store.setLastPollTime(lastPollTime);
    console.log(`[cron] Poll cycle complete. Next poll will use lastPollTime=${lastPollTime}`);
  } catch (err) {
    console.error('[cron] Unhandled error in poll cycle:', err.message);
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[index] notion-todoist-sync running on port ${PORT}`);
  console.log(`[index] Webhook endpoint: POST http://localhost:${PORT}/webhook/todoist`);
  console.log(`[index] Health check:     GET  http://localhost:${PORT}/health`);
});
