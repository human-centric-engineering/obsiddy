/**
 * GET / PATCH / DELETE /api/v1/obsiddy/tags/[id]
 *
 * Tags have no archive lifecycle — a label nobody uses is deleted rather than kept in
 * a drawer — so `DELETE` always destroys. `ObsiddyTaskTag` cascades, taking the label
 * off every task without leaving rows pointing at nothing.
 *
 * Authentication: required.
 */

import { createItemHandlers } from '@/lib/framework/obsiddy/api/handlers';
import { tagResource } from '@/lib/framework/obsiddy/services/resources';

export const { GET, PATCH, DELETE } = createItemHandlers(tagResource);
