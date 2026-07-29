/**
 * POST /api/v1/obsiddy/tasks/:id/snooze — "not this, not now".
 *
 * Takes a preset (`later_today` | `tomorrow` | `next_week` | `next_month`) or an
 * explicit `until`. Presets resolve in the user's own timezone, server-side.
 *
 * Authentication: required.
 */

import { createSnoozeHandlers } from '@/lib/framework/obsiddy/api/handlers';

export const { POST } = createSnoozeHandlers('task');
