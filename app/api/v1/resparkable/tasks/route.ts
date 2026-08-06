/**
 * GET  /api/v1/resparkable/tasks — list (owner-scoped, archived excluded by default)
 * POST /api/v1/resparkable/tasks — create
 *
 * Authentication: required. Handlers are generated so every Resparkable collection
 * shares one reviewed implementation of the scope and isolation rules — see
 * lib/framework/resparkable/api/handlers.ts.
 */

import { createCollectionHandlers } from '@/lib/framework/resparkable/api/handlers';
import { taskResource } from '@/lib/framework/resparkable/services/resources';

export const { GET, POST } = createCollectionHandlers(taskResource);
