'use strict';

const path = require('path');
let Database;

try {
  Database = require('better-sqlite3');
} catch {
  Database = null;
}

const DB_PATH = path.join(__dirname, 'sync_state.db');
const DEBOUNCE_WINDOW_MS = 90_000;

// ---------------------------------------------------------------------------
// SQLite backend
// ---------------------------------------------------------------------------

function createSqliteStore() {
  const db = new Database(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_map (
      todoist_id    TEXT,
      notion_id     TEXT,
      last_synced_at INTEGER NOT NULL,
      origin        TEXT NOT NULL,
      PRIMARY KEY (todoist_id, notion_id)
    );

    CREATE TABLE IF NOT EXISTS poll_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const stmtUpsert = db.prepare(`
    INSERT INTO sync_map (todoist_id, notion_id, last_synced_at, origin)
    VALUES (@todoistId, @notionId, @lastSyncedAt, @origin)
    ON CONFLICT(todoist_id, notion_id) DO UPDATE SET
      last_synced_at = excluded.last_synced_at,
      origin         = excluded.origin
  `);

  const stmtGetByTodoist = db.prepare(
    'SELECT * FROM sync_map WHERE todoist_id = ?'
  );

  const stmtGetByNotion = db.prepare(
    'SELECT * FROM sync_map WHERE notion_id = ?'
  );

  const stmtGetPoll = db.prepare(
    'SELECT value FROM poll_state WHERE key = ?'
  );

  const stmtSetPoll = db.prepare(`
    INSERT INTO poll_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  return {
    /**
     * Persist a todoist_id ↔ notion_id mapping and record which side wrote it.
     * @param {string} todoistId
     * @param {string} notionId
     * @param {'todoist'|'notion'} origin
     */
    upsert(todoistId, notionId, origin) {
      stmtUpsert.run({
        todoistId,
        notionId,
        lastSyncedAt: Date.now(),
        origin,
      });
    },

    /** @returns {{ todoist_id, notion_id, last_synced_at, origin } | undefined} */
    getByTodoistId(todoistId) {
      return stmtGetByTodoist.get(todoistId);
    },

    /** @returns {{ todoist_id, notion_id, last_synced_at, origin } | undefined} */
    getByNotionId(notionId) {
      return stmtGetByNotion.get(notionId);
    },

    /**
     * Mark an ID as recently synced from a given origin without changing the
     * paired ID.  Used when we know one side of the pair and want to refresh
     * the debounce timestamp.
     * @param {string} id  Either a todoist_id or notion_id value
     * @param {'todoist'|'notion'} origin
     */
    markSynced(id, origin) {
      // Try to find the row by either column and update its timestamp + origin.
      const byTodoist = stmtGetByTodoist.get(id);
      if (byTodoist) {
        stmtUpsert.run({
          todoistId: byTodoist.todoist_id,
          notionId: byTodoist.notion_id,
          lastSyncedAt: Date.now(),
          origin,
        });
        return;
      }
      const byNotion = stmtGetByNotion.get(id);
      if (byNotion) {
        stmtUpsert.run({
          todoistId: byNotion.todoist_id,
          notionId: byNotion.notion_id,
          lastSyncedAt: Date.now(),
          origin,
        });
      }
    },

    /**
     * Returns true when the record for `id` was last written by the given
     * origin within the debounce window, meaning the polling loop should skip
     * it to avoid an echo write.
     * @param {string} id  Either a todoist_id or notion_id
     * @param {number} [windowMs]
     */
    isDebounced(id, windowMs = DEBOUNCE_WINDOW_MS) {
      const row = stmtGetByTodoist.get(id) || stmtGetByNotion.get(id);
      if (!row) return false;
      return Date.now() - row.last_synced_at < windowMs;
    },

    /** Persist the last-polled timestamp for Notion. */
    setLastPollTime(isoString) {
      stmtSetPoll.run('last_notion_poll', isoString);
    },

    /** @returns {string | null} ISO timestamp of last successful Notion poll */
    getLastPollTime() {
      const row = stmtGetPoll.get('last_notion_poll');
      return row ? row.value : null;
    },
  };
}

// ---------------------------------------------------------------------------
// JSON fallback backend (when better-sqlite3 is unavailable)
// ---------------------------------------------------------------------------

const fs = require('fs');
const JSON_PATH = path.join(__dirname, 'sync_state.json');

function loadJson() {
  try {
    return JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  } catch {
    return { map: {}, poll: {} };
  }
}

function saveJson(data) {
  fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function createJsonStore() {
  console.warn(
    '[store] better-sqlite3 not available — falling back to JSON store. ' +
      'This is not safe for concurrent access.'
  );

  return {
    upsert(todoistId, notionId, origin) {
      const data = loadJson();
      const key = `${todoistId}::${notionId}`;
      data.map[key] = { todoistId, notionId, lastSyncedAt: Date.now(), origin };
      saveJson(data);
    },

    getByTodoistId(todoistId) {
      const data = loadJson();
      const entry = Object.values(data.map).find(
        (r) => r.todoistId === todoistId
      );
      if (!entry) return undefined;
      return {
        todoist_id: entry.todoistId,
        notion_id: entry.notionId,
        last_synced_at: entry.lastSyncedAt,
        origin: entry.origin,
      };
    },

    getByNotionId(notionId) {
      const data = loadJson();
      const entry = Object.values(data.map).find(
        (r) => r.notionId === notionId
      );
      if (!entry) return undefined;
      return {
        todoist_id: entry.todoistId,
        notion_id: entry.notionId,
        last_synced_at: entry.lastSyncedAt,
        origin: entry.origin,
      };
    },

    markSynced(id, origin) {
      const data = loadJson();
      for (const key of Object.keys(data.map)) {
        const r = data.map[key];
        if (r.todoistId === id || r.notionId === id) {
          r.lastSyncedAt = Date.now();
          r.origin = origin;
        }
      }
      saveJson(data);
    },

    isDebounced(id, windowMs = DEBOUNCE_WINDOW_MS) {
      const data = loadJson();
      const entry = Object.values(data.map).find(
        (r) => r.todoistId === id || r.notionId === id
      );
      if (!entry) return false;
      return Date.now() - entry.lastSyncedAt < windowMs;
    },

    setLastPollTime(isoString) {
      const data = loadJson();
      data.poll.last_notion_poll = isoString;
      saveJson(data);
    },

    getLastPollTime() {
      const data = loadJson();
      return data.poll.last_notion_poll || null;
    },
  };
}

// ---------------------------------------------------------------------------
// Export whichever backend is available
// ---------------------------------------------------------------------------

const store = Database ? createSqliteStore() : createJsonStore();

module.exports = store;
