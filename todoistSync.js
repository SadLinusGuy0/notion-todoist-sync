'use strict';

const axios = require('axios');
const store = require('./store');

const BASE_URL = 'https://api.todoist.com/rest/v2';

function getHeaders() {
  return {
    Authorization: `Bearer ${process.env.TODOIST_API_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the subset of Todoist task fields that the REST API accepts on
 * create/update from a normalised task-fields object.
 *
 * @param {{ content, due_date?, priority }} fields
 */
function buildTaskPayload(fields) {
  const payload = {
    content: fields.content,
    priority: fields.priority ?? 1,
  };
  if (fields.due_date) {
    payload.due_date = fields.due_date;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

/**
 * Create a new Todoist task.
 *
 * @param {{ content: string, due_date?: string, priority?: number }} fields
 * @param {string} notionId  The Notion page ID to associate with this task
 * @returns {Promise<object>}  The created Todoist task object
 */
async function createTodoistTask(fields, notionId) {
  console.log(`[todoistSync] Creating task: "${fields.content}"`);

  const response = await axios.post(
    `${BASE_URL}/tasks`,
    buildTaskPayload(fields),
    { headers: getHeaders() }
  );

  const task = response.data;
  console.log(`[todoistSync] Created task id=${task.id} for notion_id=${notionId}`);

  // Record the mapping and mark origin=notion so the webhook handler knows
  // this task was created programmatically and can suppress echo events if
  // Todoist fires a webhook for our own write.
  store.upsert(String(task.id), notionId, 'notion');

  return task;
}

/**
 * Update an existing Todoist task's fields.
 *
 * @param {string} todoistId
 * @param {{ content?: string, due_date?: string, priority?: number }} fields
 * @param {string} notionId  Used to refresh the debounce timestamp
 * @returns {Promise<object>}  The updated Todoist task object
 */
async function updateTodoistTask(todoistId, fields, notionId) {
  console.log(`[todoistSync] Updating task id=${todoistId}`);

  const response = await axios.post(
    `${BASE_URL}/tasks/${todoistId}`,
    buildTaskPayload(fields),
    { headers: getHeaders() }
  );

  const task = response.data;
  store.markSynced(String(todoistId), 'notion');
  console.log(`[todoistSync] Updated task id=${todoistId} notion_id=${notionId}`);

  return task;
}

/**
 * Mark a Todoist task as completed.
 *
 * @param {string} todoistId
 * @returns {Promise<void>}
 */
async function closeTodoistTask(todoistId) {
  console.log(`[todoistSync] Closing task id=${todoistId}`);

  await axios.post(
    `${BASE_URL}/tasks/${todoistId}/close`,
    {},
    { headers: getHeaders() }
  );

  store.markSynced(String(todoistId), 'notion');
  console.log(`[todoistSync] Closed task id=${todoistId}`);
}

/**
 * Delete a Todoist task.
 *
 * @param {string} todoistId
 * @returns {Promise<void>}
 */
async function deleteTodoistTask(todoistId) {
  console.log(`[todoistSync] Deleting task id=${todoistId}`);

  await axios.delete(`${BASE_URL}/tasks/${todoistId}`, {
    headers: getHeaders(),
  });

  store.markSynced(String(todoistId), 'notion');
  console.log(`[todoistSync] Deleted task id=${todoistId}`);
}

module.exports = {
  createTodoistTask,
  updateTodoistTask,
  closeTodoistTask,
  deleteTodoistTask,
};
