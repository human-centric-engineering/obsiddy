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

  SEARCH: '/api/v1/obsiddy/search',
  REINDEX: '/api/v1/obsiddy/reindex',

  TASKS: '/api/v1/obsiddy/tasks',
  PROJECTS: '/api/v1/obsiddy/projects',
  GOALS: '/api/v1/obsiddy/goals',
  AREAS: '/api/v1/obsiddy/areas',
  THOUGHTS: '/api/v1/obsiddy/thoughts',
  ENTITIES: '/api/v1/obsiddy/entities',
  TIME_BLOCKS: '/api/v1/obsiddy/time-blocks',

  LINKS: '/api/v1/obsiddy/links',
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
