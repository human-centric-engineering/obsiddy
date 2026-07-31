/**
 * Obsiddy's endpoint paths.
 *
 * A tier-owned mirror of `lib/api/endpoints.ts`, which is **Sunrise-owned**:
 * adding Obsiddy's routes there would be a merge conflict inflicted on every host
 * project on every upgrade, and the zero-core-file rule exists precisely to stop
 * that (§17 risk 1b). Client components import from here instead.
 *
 * Server code calls services directly and has no use for these; they exist so a
 * `'use client'` component never hard-codes a path string that a later rename
 * would silently break.
 */

export const OBSIDDY_API = {
  TODAY: '/api/v1/obsiddy/today',
  INBOX: '/api/v1/obsiddy/inbox',
  SPACE: '/api/v1/obsiddy/space',
  /** Badge numbers for the shell — cheap enough to read on every navigation. */
  COUNTS: '/api/v1/obsiddy/counts',

  SEARCH: '/api/v1/obsiddy/search',
  REINDEX: '/api/v1/obsiddy/reindex',

  TASKS: '/api/v1/obsiddy/tasks',
  PROJECTS: '/api/v1/obsiddy/projects',
  GOALS: '/api/v1/obsiddy/goals',
  AREAS: '/api/v1/obsiddy/areas',
  THOUGHTS: '/api/v1/obsiddy/thoughts',
  ENTITIES: '/api/v1/obsiddy/entities',
  TIME_BLOCKS: '/api/v1/obsiddy/time-blocks',
  BOARDS: '/api/v1/obsiddy/boards',
  TAGS: '/api/v1/obsiddy/tags',

  /**
   * Item and action paths for the collections above.
   *
   * `collection` is one of the constants on this object, so a caller composes
   * `itemPath(OBSIDDY_API.TASKS, id)` rather than re-typing the prefix. The three
   * lifecycle actions are named rather than string-built because each has
   * behaviour a raw `PATCH` of the underlying column would skip — the snooze pair
   * increments `snoozeCount` and logs an event, and restore nulls `indexedHash`
   * so the item is re-embedded (see `api/handlers.ts`).
   */
  itemPath: (collection: string, id: string): string => `${collection}/${id}`,
  snoozePath: (collection: string, id: string): string => `${collection}/${id}/snooze`,
  unsnoozePath: (collection: string, id: string): string => `${collection}/${id}/unsnooze`,
  restorePath: (collection: string, id: string): string => `${collection}/${id}/restore`,

  /** Triage: one thought becomes a task, a project or a goal. */
  promotePath: (id: string): string => `/api/v1/obsiddy/thoughts/${id}/promote`,

  /** Explicit board membership. Filter-backed boards never use these. */
  boardCards: (boardId: string): string => `/api/v1/obsiddy/boards/${boardId}/cards`,
  boardCard: (boardId: string, cardId: string): string =>
    `/api/v1/obsiddy/boards/${boardId}/cards/${cardId}`,
  boardExport: (boardId: string, format: 'csv' | 'json'): string =>
    `/api/v1/obsiddy/boards/${boardId}/export?format=${format}`,

  /** A task's labels, set as a whole rather than added one at a time. */
  taskTags: (taskId: string): string => `/api/v1/obsiddy/tasks/${taskId}/tags`,
  taskChecklist: (taskId: string): string => `/api/v1/obsiddy/tasks/${taskId}/checklist`,
  checklistItem: (id: string): string => `/api/v1/obsiddy/checklist/${id}`,

  /**
   * The enriched read behind a detail page — one request, fixed query count.
   *
   * A sibling of the item route rather than an `?include=` on it, so the generic
   * item handlers stay bare (see `services/details.ts`).
   */
  viewPath: (collection: string, id: string): string => `${collection}/${id}/view`,

  LINKS: '/api/v1/obsiddy/links',
  /** The review queue, with both ends of each link resolved. */
  CONNECTIONS: '/api/v1/obsiddy/connections',
  /** A neighbourhood around one node — never the whole corpus. */
  GRAPH: '/api/v1/obsiddy/graph',
  linkById: (id: string): string => `/api/v1/obsiddy/links/${id}`,
  CONNECTIONS_SWEEP: '/api/v1/obsiddy/connections/sweep',

  DOCUMENTS: '/api/v1/obsiddy/documents',
  documentById: (id: string): string => `/api/v1/obsiddy/documents/${id}`,
  documentDownload: (id: string): string => `/api/v1/obsiddy/documents/${id}/download`,

  /** Admin surface — instance settings, not user data. */
  ADMIN: {
    SETTINGS: '/api/v1/admin/obsiddy/settings',
  },
} as const;
