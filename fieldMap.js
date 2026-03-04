'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Priority mapping
//
// Todoist uses an inverted scale compared to Notion selects:
//   Todoist priority 4 → P1 (highest)
//   Todoist priority 3 → P2
//   Todoist priority 2 → P3
//   Todoist priority 1 → P4 (lowest / default)
// ---------------------------------------------------------------------------

const TODOIST_TO_NOTION_PRIORITY = {
  4: 'P1',
  3: 'P2',
  2: 'P3',
  1: 'P4',
};

const NOTION_TO_TODOIST_PRIORITY = {
  P1: 4,
  P2: 3,
  P3: 2,
  P4: 1,
};

// ---------------------------------------------------------------------------
// Datetime helpers
// ---------------------------------------------------------------------------

/** Returns true when an ISO date string includes a time component (HH:MM). */
function hasTime(dateStr) {
  return typeof dateStr === 'string' && dateStr.includes('T');
}

/**
 * Add a Todoist duration to a start datetime string and return the end
 * datetime as an ISO string that preserves the input's timezone style.
 *
 * @param {string} startStr   ISO date or datetime string
 * @param {number} amount     Duration amount
 * @param {'minute'|'day'} unit
 * @returns {string}
 */
function addDuration(startStr, amount, unit) {
  const addMs =
    unit === 'minute'
      ? amount * 60_000
      : amount * 24 * 60 * 60_000;

  const end = new Date(new Date(startStr).getTime() + addMs);

  if (startStr.endsWith('Z')) {
    // UTC — return compact ISO with Z
    return end.toISOString().replace(/\.\d+Z$/, 'Z');
  }
  if (startStr.includes('T')) {
    // Local datetime (no timezone) — strip the trailing Z that toISOString adds
    return end.toISOString().replace(/\.\d+Z$/, '');
  }
  // Date-only input
  return end.toISOString().slice(0, 10);
}

/**
 * Calculate the Todoist duration between two ISO date/datetime strings.
 * Returns null when end ≤ start or the inputs are falsy.
 *
 * @param {string} startStr
 * @param {string} endStr
 * @returns {{ amount: number, unit: 'minute'|'day' } | null}
 */
function calcDuration(startStr, endStr) {
  if (!startStr || !endStr) return null;
  const diffMs = new Date(endStr).getTime() - new Date(startStr).getTime();
  if (diffMs <= 0) return null;

  if (hasTime(startStr)) {
    return { amount: Math.round(diffMs / 60_000), unit: 'minute' };
  }
  return { amount: Math.round(diffMs / (24 * 60 * 60_000)), unit: 'day' };
}

// ---------------------------------------------------------------------------
// Notion page → Todoist task fields
// ---------------------------------------------------------------------------

/**
 * Extract synced fields from a Notion page object and return a flat object
 * suitable for passing to the Todoist REST API.
 *
 * @param {import('@notionhq/client').GetPageResponse} page
 * @returns {{
 *   content: string,
 *   due_date?: string,
 *   priority: number,
 *   is_done: boolean,
 *   todoist_id?: string,
 *   labels: string[],
 *   recurrence_string?: string,
 *   duration_amount?: number,
 *   duration_unit?: 'minute'|'day'
 * }}
 */
function notionPageToTodoistTask(page) {
  const props = page.properties;

  // Title / Name
  const titleParts = props?.Name?.title ?? [];
  const content = titleParts.map((t) => t.plain_text).join('') || '(untitled)';

  // Due date — Notion date property returns { start, end, ... }
  const dueStart = props?.Due?.date?.start ?? undefined;
  const dueEnd = props?.Due?.date?.end ?? undefined;
  const due_date = dueStart;

  // Duration derived from the Notion date range (end − start)
  let duration_amount;
  let duration_unit;
  if (dueStart && dueEnd) {
    const dur = calcDuration(dueStart, dueEnd);
    if (dur) {
      duration_amount = dur.amount;
      duration_unit = dur.unit;
    }
  }

  // Priority select
  const priorityLabel = props?.Priority?.select?.name ?? 'P4';
  const priority = NOTION_TO_TODOIST_PRIORITY[priorityLabel] ?? 1;

  // Done checkbox, or Status select with "Done" / "Completed"
  const doneCheckbox = props?.Done?.checkbox ?? false;
  const statusName = props?.Status?.select?.name ?? '';
  const statusDone = /^(done|completed)$/i.test(statusName.trim());
  const is_done = doneCheckbox || statusDone;

  // Stored Todoist task ID (for reverse lookup)
  const todoist_id_parts = props?.TodoistID?.rich_text ?? [];
  const todoist_id = todoist_id_parts.map((t) => t.plain_text).join('') || undefined;

  // Labels / tags — multi-select option names map directly to Todoist label strings
  const labels = (props?.Labels?.multi_select ?? []).map((opt) => opt.name);

  // Recurrence string (e.g. "every day", "every week on Monday")
  const recurrenceParts = props?.Recurrence?.rich_text ?? [];
  const recurrence_string = recurrenceParts.map((t) => t.plain_text).join('') || undefined;

  return {
    content,
    due_date,
    priority,
    is_done,
    todoist_id,
    labels,
    recurrence_string,
    duration_amount,
    duration_unit,
  };
}

// ---------------------------------------------------------------------------
// Todoist task → Notion properties payload
// ---------------------------------------------------------------------------

/**
 * Build a Notion `properties` payload from a Todoist task object.
 *
 * @param {object} task            Raw Todoist task object (REST API v1)
 * @param {string} [todoistId]     Explicit task ID to store in TodoistID property
 * @param {string|null} [projectName]  Resolved project display name
 * @returns {object}  Notion properties object
 */
function todoistTaskToNotionProps(task, todoistId, projectName) {
  const id = todoistId ?? task.id;
  const isRecurring = task.due?.is_recurring ?? false;

  const props = {
    Name: {
      title: [{ type: 'text', text: { content: task.content ?? '' } }],
    },
    Priority: {
      select: { name: TODOIST_TO_NOTION_PRIORITY[task.priority] ?? 'P4' },
    },
    Done: {
      checkbox: task.is_completed ?? false,
    },
    TodoistID: {
      rich_text: [{ type: 'text', text: { content: String(id) } }],
    },
    Labels: {
      multi_select: (task.labels ?? []).map((name) => ({ name })),
    },
    Recurring: {
      checkbox: isRecurring,
    },
    Recurrence: {
      rich_text: isRecurring && task.due?.string
        ? [{ type: 'text', text: { content: task.due.string } }]
        : [],
    },
  };

  // Project select
  if (projectName) {
    props.Project = { select: { name: projectName } };
  }

  // Due date / datetime — augmented with end time when a duration is present
  const dueStart = task.due?.date ?? task.due_date ?? null;
  if (dueStart) {
    const dur = task.duration ?? null;
    let dueEnd = null;

    if (dur?.amount) {
      dueEnd = addDuration(dueStart, dur.amount, dur.unit ?? 'minute');
    }

    props.Due = {
      date: {
        start: dueStart,
        ...(dueEnd ? { end: dueEnd } : {}),
      },
    };
  }

  return props;
}

// ---------------------------------------------------------------------------
// Task hash — change detection for the Todoist polling loop
// ---------------------------------------------------------------------------

/**
 * Produce a SHA-1 digest of the fields we sync from Todoist.
 * The polling loop skips a Notion update when the hash is unchanged,
 * preventing unnecessary writes and echo loops.
 *
 * @param {object} task  Todoist REST API task object
 * @returns {string}  40-char hex SHA-1 digest
 */
function hashTodoistTask(task) {
  const normalized = [
    task.content ?? '',
    String(task.priority ?? 1),
    task.due?.date ?? '',
    task.due?.is_recurring ? '1' : '0',
    task.due?.string ?? '',
    (task.labels ?? []).slice().sort().join(','),
    String(task.project_id ?? ''),
    String(task.duration?.amount ?? ''),
    task.duration?.unit ?? '',
  ].join('\x00');

  return crypto.createHash('sha1').update(normalized).digest('hex');
}

module.exports = {
  notionPageToTodoistTask,
  todoistTaskToNotionProps,
  hashTodoistTask,
  hasTime,
  TODOIST_TO_NOTION_PRIORITY,
  NOTION_TO_TODOIST_PRIORITY,
};
