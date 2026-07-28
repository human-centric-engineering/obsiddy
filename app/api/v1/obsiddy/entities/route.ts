/**
 * GET  /api/v1/obsiddy/entities — list (owner-scoped, archived excluded by default)
 * POST /api/v1/obsiddy/entities — create
 *
 * Authentication: required. Handlers are generated so every Obsiddy collection
 * shares one reviewed implementation of the scope and isolation rules — see
 * lib/framework/obsiddy/api/handlers.ts.
 */

import { createCollectionHandlers } from '@/lib/framework/obsiddy/api/handlers';
import { entityResource } from '@/lib/framework/obsiddy/services/resources';

export const { GET, POST } = createCollectionHandlers(entityResource);
