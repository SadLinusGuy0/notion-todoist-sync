'use strict';

const axios = require('axios');

const CACHE_TTL_MS = 5 * 60 * 1000; // refresh every 5 minutes

let projectMap = {};  // { [projectId]: projectName }
let lastFetched = 0;

/**
 * Return the display name for a Todoist project ID.
 * Fetches and caches the full project list on first call and after TTL expiry.
 *
 * @param {string|null} projectId
 * @returns {Promise<string|null>}
 */
async function getProjectName(projectId) {
  if (!projectId) return null;

  if (Date.now() - lastFetched > CACHE_TTL_MS) {
    await refreshCache();
  }

  return projectMap[projectId] ?? null;
}

async function refreshCache() {
  try {
    const response = await axios.get('https://api.todoist.com/api/v1/projects', {
      headers: { Authorization: `Bearer ${process.env.TODOIST_API_TOKEN}` },
    });

    const body = response.data;
    const projects = Array.isArray(body)
      ? body
      : (body.results ?? body.items ?? []);

    projectMap = {};
    for (const p of projects) {
      projectMap[p.id] = p.name;
    }

    lastFetched = Date.now();
    console.log(`[projectCache] Cached ${projects.length} project(s)`);
  } catch (err) {
    console.warn(
      `[projectCache] Could not refresh project list: ${err.response?.status ?? err.message}. ` +
        'Project names will fall back to null until next successful refresh.'
    );
  }
}

module.exports = { getProjectName, refreshCache };
