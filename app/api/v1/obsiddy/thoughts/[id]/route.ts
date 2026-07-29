/**
 * GET    /api/v1/obsiddy/thoughts/:id — read one
 * PATCH  /api/v1/obsiddy/thoughts/:id — update
 * DELETE /api/v1/obsiddy/thoughts/:id — archive (`?permanent=true` destroys)
 *
 * Authentication: required. Another user's id returns 404, not 403 — the
 * response must not confirm that the row exists.
 */

import { createItemHandlers } from '@/lib/framework/obsiddy/api/handlers';
import { thoughtResource } from '@/lib/framework/obsiddy/services/resources';

export const { GET, PATCH, DELETE } = createItemHandlers(thoughtResource);
