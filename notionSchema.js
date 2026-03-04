'use strict';

const { Client } = require('@notionhq/client');

const SCHEMA_TTL_MS = 60 * 60 * 1000; // refresh every hour

let knownProps = null; // Set<string> of property names in the database
let lastFetched = 0;

/**
 * Fetch (or return cached) the set of property names that exist in the
 * configured Notion database.
 *
 * @returns {Promise<Set<string>>}
 */
async function getKnownProps() {
  if (!knownProps || Date.now() - lastFetched > SCHEMA_TTL_MS) {
    await refreshSchema();
  }
  return knownProps;
}

/**
 * Fetch the database schema from Notion and rebuild the property name cache.
 * Returns the Set of property names so callers can inspect it.
 *
 * @returns {Promise<Set<string>>}
 */
async function refreshSchema() {
  const client = new Client({ auth: process.env.NOTION_API_KEY });

  const db = await client.databases.retrieve({
    database_id: process.env.NOTION_DATABASE_ID,
  });

  knownProps = new Set(Object.keys(db.properties));
  lastFetched = Date.now();

  return { props: knownProps, title: db.title?.[0]?.plain_text ?? db.id };
}

/**
 * Return a copy of `properties` with any key not present in the database
 * silently removed.  Logs a one-time warning the first time each unknown
 * property is encountered so the operator knows what to add.
 *
 * @param {object} properties  Notion properties payload object
 * @returns {Promise<object>}
 */
const warnedMissing = new Set();

async function filterProps(properties) {
  const known = await getKnownProps();
  const filtered = {};

  for (const [key, value] of Object.entries(properties)) {
    if (known.has(key)) {
      filtered[key] = value;
    } else if (!warnedMissing.has(key)) {
      warnedMissing.add(key);
      console.warn(
        `[schema] Property "${key}" does not exist in the Notion database — ` +
          'skipping. Add it to the database to enable syncing of this field.'
      );
    }
  }

  return filtered;
}

module.exports = { refreshSchema, getKnownProps, filterProps };
