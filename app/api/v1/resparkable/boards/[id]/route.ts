/**
 * GET / PATCH / DELETE /api/v1/resparkable/boards/[id]
 *
 * `DELETE` archives; `?permanent=true` destroys the board and its membership rows.
 * Neither touches a task — the board only ever referenced them.
 *
 * Authentication: required.
 */

import { createItemHandlers } from '@/lib/framework/resparkable/api/handlers';
import { boardResource } from '@/lib/framework/resparkable/services/resources';

export const { GET, PATCH, DELETE } = createItemHandlers(boardResource);
