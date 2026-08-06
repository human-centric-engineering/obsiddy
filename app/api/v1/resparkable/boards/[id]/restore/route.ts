/**
 * POST /api/v1/resparkable/boards/[id]/restore — un-archive a board.
 *
 * Authentication: required.
 */

import { createRestoreHandler } from '@/lib/framework/resparkable/api/handlers';
import { boardResource } from '@/lib/framework/resparkable/services/resources';

export const { POST } = createRestoreHandler(boardResource);
