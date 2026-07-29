/**
 * POST /api/v1/obsiddy/thoughts/:id/unsnooze — bring it back early.
 *
 * `snoozeCount` is not decremented: it counts the gesture, not the state.
 *
 * Authentication: required.
 */

import { createUnsnoozeHandlers } from '@/lib/framework/obsiddy/api/handlers';

export const { POST } = createUnsnoozeHandlers('thought');
