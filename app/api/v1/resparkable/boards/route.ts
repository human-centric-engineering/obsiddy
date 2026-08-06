/**
 * GET  /api/v1/resparkable/boards — list saved boards
 * POST /api/v1/resparkable/boards — create one
 *
 * A board is a *view* over tasks that already exist (§12), so creating one writes no
 * tasks and deleting one destroys none. Handlers are generated so the scope and
 * isolation rules have one reviewed implementation — see `api/handlers.ts`.
 *
 * Authentication: required.
 */

import { createCollectionHandlers } from '@/lib/framework/resparkable/api/handlers';
import { boardResource } from '@/lib/framework/resparkable/services/resources';

export const { GET, POST } = createCollectionHandlers(boardResource);
