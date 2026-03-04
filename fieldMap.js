'use strict';

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
 *   todoist_id?: string
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

  return { content, due_date, priority, is_done, todoist_id };
}

// ---------------------------------------------------------------------------
// Todoist task → Notion properties payload
// ---------------------------------------------------------------------------

/**
 * Build a Notion `properties` payload from a Todoist task object (as returned
 * by the Todoist REST API v2).
 *
 * @param {object} task  Raw Todoist task object
 * @param {string} [todoistId]  Explicit task ID to store in TodoistID property
 * @returns {object}  Notion properties object
 */
function todoistTaskToNotionProps(task, todoistId) {
  const id = todoistId ?? task.id;

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
  };

  // Only set Due if a due date is present — avoid overwriting with null
  const dueDate = task.due?.date ?? task.due_date ?? null;
  if (dueDate) {
    props.Due = {
      date: { start: dueDate },
    };
  }

  return props;
}

module.exports = {
  notionPageToTodoistTask,
  todoistTaskToNotionProps,
  TODOIST_TO_NOTION_PRIORITY,
  NOTION_TO_TODOIST_PRIORITY,
};
