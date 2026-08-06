/**
 * GET  /api/v1/resparkable/projects — list (owner-scoped, archived excluded by default)
 * POST /api/v1/resparkable/projects — create
 *
 * Authentication: required. Handlers are generated so every Resparkable collection
 * shares one reviewed implementation of the scope and isolation rules — see
 * lib/framework/resparkable/api/handlers.ts.
 */

import { createCollectionHandlers } from '@/lib/framework/resparkable/api/handlers';
import { projectResource } from '@/lib/framework/resparkable/services/resources';

export const { GET, POST } = createCollectionHandlers(projectResource);
