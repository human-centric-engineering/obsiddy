/**
 * POST /api/v1/resparkable/tasks/:id/snooze — "not this, not now".
 *
 * Takes a preset (`later_today` | `tomorrow` | `next_week` | `next_month`) or an
 * explicit `until`. Presets resolve in the user's own timezone, server-side.
 *
 * Authentication: required.
 */

import { createSnoozeHandlers } from '@/lib/framework/resparkable/api/handlers';

export const { POST } = createSnoozeHandlers('task');
