# notion-todoist-sync

A bidirectional sync service between [Todoist](https://todoist.com) and a [Notion](https://notion.so) database.

- **Todoist → Notion**: driven by Todoist webhooks (real-time)
- **Notion → Todoist**: driven by a 60-second polling loop
- **Loop prevention**: 90-second debounce window recorded in SQLite prevents echo writes

---

## Notion Database Setup

Before running the service, create a Notion database with **exactly** these properties:

| Property name | Type | Notes |
|---|---|---|
| `Name` | Title | Task title |
| `Due` | Date | Due date |
| `Priority` | Select | Options: `P1`, `P2`, `P3`, `P4` |
| `Done` | Checkbox | Completion state |
| `TodoistID` | Rich Text | Hidden — stores the Todoist task ID for reverse lookup |

Then share the database with your Notion integration (click ··· → Connections on the database page).

---

## Local Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` and fill in all values:

```
TODOIST_API_TOKEN=   # From https://app.todoist.com/app/settings/integrations/developer
NOTION_API_KEY=      # From https://www.notion.so/my-integrations
NOTION_DATABASE_ID=  # The ID in your database URL (see below)
WEBHOOK_SECRET=      # A random secret — see below for how to generate one
PORT=3000
```

**Finding your Notion Database ID:**
Open the database as a full page. The URL looks like:
```
https://www.notion.so/myworkspace/83b2d3a4b5c6d7e8f9a0b1c2d3e4f5a6?v=...
```
The 32-character hex string before `?v=` is the database ID.

**Generating a webhook secret:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Start the server

```bash
npm start
```

The server starts on `http://localhost:3000`. You should see:
```
[index] notion-todoist-sync running on port 3000
[index] Webhook endpoint: POST http://localhost:3000/webhook/todoist
[index] Health check:     GET  http://localhost:3000/health
```

---

## Registering the Todoist Webhook

Todoist webhooks must be registered via the [Todoist developer console](https://developer.todoist.com/appconsole.html) or the Sync API. Your server must be publicly reachable (use [ngrok](https://ngrok.com) for local testing).

**Events to subscribe to:**
- `item:added`
- `item:updated`
- `item:completed`
- `item:deleted`

**Webhook URL:** `https://<your-public-domain>/webhook/todoist`

**Client secret:** Set this to the same value as `WEBHOOK_SECRET` in your `.env`. Todoist will sign every payload with HMAC-SHA256 using this secret, and the service will reject any request with an invalid signature.

### Testing locally with ngrok

```bash
# In one terminal
npm start

# In another terminal
ngrok http 3000
```

Use the `https://....ngrok.io` URL as your webhook endpoint when registering.

---

## Deploy to Railway

1. Push this repository to GitHub.
   - `.env` is listed in `.gitignore` — confirm it does **not** appear in your commit. Secrets belong in Railway's Variables dashboard, not in source control.

2. Go to [railway.app](https://railway.app) and create a new project.

3. Click **Deploy from GitHub repo** and select your repository.

4. Open the **Variables** tab and add all five variables from `.env.example` directly in the Railway UI:

   | Variable | Where to get it |
   |---|---|
   | `TODOIST_API_TOKEN` | [Todoist integrations settings](https://app.todoist.com/app/settings/integrations/developer) |
   | `NOTION_API_KEY` | [Notion my-integrations](https://www.notion.so/my-integrations) |
   | `NOTION_DATABASE_ID` | Your database page URL (see Local Setup above) |
   | `WEBHOOK_SECRET` | Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
   | `PORT` | Railway injects this automatically — you can omit it |

   > Railway injects these directly into `process.env`. The service deliberately skips loading any `.env` file when `NODE_ENV=production` (which Railway sets automatically), so there is no risk of a stale or committed `.env` file overriding the dashboard values.

5. Railway detects `npm start` automatically from `package.json`.

6. Once deployed, copy the generated URL (e.g. `https://notion-todoist-sync.up.railway.app`).

7. Register `https://notion-todoist-sync.up.railway.app/webhook/todoist` as your Todoist webhook endpoint.

> **Note:** The free Railway tier may sleep idle services. Use the health check endpoint (`GET /health`) with an external uptime monitor (e.g. [UptimeRobot](https://uptimerobot.com)) to keep the service awake.

---

## Deploy to Render

1. Push this repository to GitHub.

2. Go to [render.com](https://render.com) and create a new **Web Service**.

3. Connect your GitHub repository.

4. Set the **Start Command** to `node index.js`.

5. Add environment variables in the **Environment** tab.

6. Deploy and use the generated `.onrender.com` URL for the Todoist webhook.

> **Note:** Render free tier services spin down after 15 minutes of inactivity. The same UptimeRobot ping strategy above applies.

---

## Architecture

```
Todoist ──webhook──► POST /webhook/todoist
                           │
                    HMAC validation
                           │
                    event dispatcher
                    ┌──────┴───────────────┐
               item:added            item:updated
               item:completed        item:deleted
                    │
              notionSync.js ──────► Notion API
                    │
                 store.js (SQLite)
                    │
              notionSync.js ◄── cron (every 60s)
                    │
               Notion API ──changed pages──► todoistSync.js ──► Todoist API
```

### Sync state store

The service persists a `sync_map` table in `sync_state.db` (SQLite) with schema:

```
todoist_id TEXT, notion_id TEXT, last_synced_at INTEGER, origin TEXT
```

- `origin` records which side (`'todoist'` or `'notion'`) last wrote the record.
- `isDebounced(id)` returns `true` if the record was last written within 90 seconds — the polling loop and webhook handler both call this to skip echo writes.

---

## Field Mapping

| Notion Property | Todoist Field | Notes |
|---|---|---|
| `Name` (title) | `content` | Direct string |
| `Due` (date) | `due_date` | ISO 8601 date |
| `Priority` (select) | `priority` | P1↔4, P2↔3, P3↔2, P4↔1 (inverted) |
| `Done` (checkbox) | completed state | Boolean |
| `TodoistID` (rich text) | task `id` | Written by service, not the user |

---

## Logs

Every sync event is logged to stdout with a `[module]` prefix:

```
[webhook] Received event: item:added for task id=12345678
[notionSync] Creating page for todoist task id=12345678 "Buy milk"
[notionSync] Created page id=abc123... for todoist_id=12345678
[cron] Starting Notion poll cycle
[notionSync] Polling Notion for pages modified since 2024-01-01T12:00:00.000Z
[notionSync] Found 2 changed page(s)
[notionSync] Skipping debounced page id=abc123...
[todoistSync] Updating task id=12345678
```

---

## Troubleshooting

**Webhook signature rejected (401)**
- Ensure `WEBHOOK_SECRET` matches the client secret set in the Todoist developer console exactly.

**Notion pages not created**
- Confirm the Notion integration has been added as a connection to your database.
- Check that all required property names match exactly (case-sensitive).

**Echo loop suspected**
- Check logs for `Skipping debounced` messages — these confirm the debounce is working.
- If loops persist, increase the `DEBOUNCE_WINDOW_MS` constant in `store.js` (default: 90,000 ms).

**SQLite not available (e.g. some ARM builds)**
- The service falls back to a JSON file store automatically. Check for the `[store] falling back to JSON store` warning in logs.
