/**
 * Obsiddy's page paths — the UI counterpart to `api/endpoints.ts`.
 *
 * Same reasoning as that file: a `'use client'` component that hard-codes
 * `/obsiddy/projects/${id}` is a rename waiting to break silently, and the whole
 * tier is meant to be relocatable by a host project. Nothing here imports
 * anything, so it is safe from any runtime including the proxy.
 *
 * `BASE` is the one string a fork would change to mount the brain somewhere else.
 * It must stay in step with `appProtectedRoutes` in `lib/app/protected-routes.ts`
 * — a mounted path that isn't listed there is a page that renders to signed-out
 * visitors before any handler gets a say.
 */

const BASE = '/obsiddy';

export const OBSIDDY_ROUTES = {
  BASE,

  TODAY: BASE,
  INBOX: `${BASE}/inbox`,
  SEARCH: `${BASE}/search`,
  CHAT: `${BASE}/chat`,
  SETTINGS: `${BASE}/settings`,
  PLAN: `${BASE}/plan`,

  PROJECTS: `${BASE}/projects`,
  project: (id: string): string => `${BASE}/projects/${id}`,

  GOALS: `${BASE}/goals`,
  AREAS: `${BASE}/areas`,

  ENTITIES: `${BASE}/entities`,
  entity: (id: string): string => `${BASE}/entities/${id}`,

  DOCUMENTS: `${BASE}/documents`,
  CONNECTIONS: `${BASE}/connections`,

  GRAPH: `${BASE}/graph`,
  /** The graph opens focused on one node — never on the whole corpus (§9). */
  graphFocus: (type: string, id: string): string =>
    `${BASE}/graph?focusType=${encodeURIComponent(type)}&focus=${encodeURIComponent(id)}`,

  BOARDS: `${BASE}/boards`,
  board: (slug: string): string => `${BASE}/boards/${slug}`,

  /** Search prefilled from the layout's box. */
  searchFor: (query: string): string => `${BASE}/search?q=${encodeURIComponent(query)}`,
} as const;
