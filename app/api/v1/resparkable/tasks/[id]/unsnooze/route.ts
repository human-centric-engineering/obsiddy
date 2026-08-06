/**
 * POST /api/v1/resparkable/tasks/:id/unsnooze — bring it back early.
 *
 * `snoozeCount` is not decremented: it counts the gesture, not the state.
 *
 * Authentication: required.
 */

import { createUnsnoozeHandlers } from '@/lib/framework/resparkable/api/handlers';

export const { POST } = createUnsnoozeHandlers('task');
