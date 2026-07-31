/**
 * POST /api/v1/obsiddy/boards/[id]/restore — un-archive a board.
 *
 * Authentication: required.
 */

import { createRestoreHandler } from '@/lib/framework/obsiddy/api/handlers';
import { boardResource } from '@/lib/framework/obsiddy/services/resources';

export const { POST } = createRestoreHandler(boardResource);
