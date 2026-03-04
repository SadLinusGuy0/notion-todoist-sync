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
 *   recurrence_string?: string
 * }}
 */
function notionPageToTodoistTask(page) {
  const props = page.properties;

  // Title / Name
  const titleParts = props?.Name?.title ?? [];
  const content = titleParts.map((t) => t.plain_text).join('') || '(untitled)';

  // Due date — Notion date property returns { start, end, ... }
  const due_date = props?.Due?.date?.start ?? undefined;

  // Priority select
  const priorityLabel = props?.Priority?.select?.name ?? 'P4';
  const priority = NOTION_TO_TODOIST_PRIORITY[priorityLabel] ?? 1;

  // Done checkbox
  const is_done = props?.Done?.checkbox ?? false;

  // Stored Todoist task ID (for reverse lookup)
  const todoist_id_parts = props?.TodoistID?.rich_text ?? [];
  const todoist_id = todoist_id_parts.map((t) => t.plain_text).join('') || undefined;

  // Labels / tags — multi-select option names map directly to Todoist label strings
  const labels = (props?.Labels?.multi_select ?? []).map((opt) => opt.name);

  // Recurrence string (e.g. "every day", "every week on Monday")
  // When present, this is passed to Todoist as due_string so the recurrence
  // is preserved on create/update.
  const recurrenceParts = props?.Recurrence?.rich_text ?? [];
  const recurrence_string = recurrenceParts.map((t) => t.plain_text).join('') || undefined;

  return { content, due_date, priority, is_done, todoist_id, labels, recurrence_string };
}

// ---------------------------------------------------------------------------
// Todoist task → Notion properties payload
// ---------------------------------------------------------------------------

/**
 * Build a Notion `properties` payload from a Todoist task object.
 *
 * @param {object} task         Raw Todoist task object (REST API v1)
 * @param {string} [todoistId]  Explicit task ID to store in TodoistID property
 * @param {string|null} [projectName]  Resolved project display name
 * @returns {object}  Notion properties object
 */
function todoistTaskToNotionProps(task, todoistId, projectName) {
  const id = todoistId ?? task.id;
  const isRecurring = task.due?.is_recurring ?? false;

  const props = {
    Name: {
      title: [
        {
          type: 'text',
          text: { content: task.content ?? '' },
        },
      ],
    },
    Priority: {
      select: {
        name: TODOIST_TO_NOTION_PRIORITY[task.priority] ?? 'P4',
      },
    },
    Done: {
      checkbox: task.is_completed ?? false,
    },
    TodoistID: {
      rich_text: [
        {
          type: 'text',
          text: { content: String(id) },
        },
      ],
    },
    // Labels: array of label name strings in Todoist → multi-select options in Notion
    Labels: {
      multi_select: (task.labels ?? []).map((name) => ({ name })),
    },
    // Recurring checkbox
    Recurring: {
      checkbox: isRecurring,
    },
    // Human-readable recurrence pattern (e.g. "every day") — blank when not recurring
    Recurrence: {
      rich_text: isRecurring && task.due?.string
        ? [{ type: 'text', text: { content: task.due.string } }]
        : [],
    },
  };

  // Project select — only set when a name was resolved; avoids overwriting with null
  if (projectName) {
    props.Project = {
      select: { name: projectName },
    };
  }

  // Due date — only set when present to avoid clearing an existing date
  const dueDate = task.due?.date ?? task.due_date ?? null;
  if (dueDate) {
    props.Due = {
      date: { start: dueDate },
    };
  }

  return props;
}

// ---------------------------------------------------------------------------
// Task hash — change detection for the Todoist polling loop
// ---------------------------------------------------------------------------

/**
 * Produce a short SHA-1 digest of the fields we sync from Todoist.
 * The polling loop compares this against the stored hash and skips the Notion
 * update when the hash is unchanged, preventing unnecessary writes and the
 * echo loop that would follow.
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
  ].join('\x00');

  return crypto.createHash('sha1').update(normalized).digest('hex');
}

module.exports = {
  notionPageToTodoistTask,
  todoistTaskToNotionProps,
  hashTodoistTask,
  TODOIST_TO_NOTION_PRIORITY,
  NOTION_TO_TODOIST_PRIORITY,
};
