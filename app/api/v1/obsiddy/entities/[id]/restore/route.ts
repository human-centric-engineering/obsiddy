/**
 * POST /api/v1/obsiddy/entities/:id/restore — clear archivedAt and re-enqueue
 * the item for embedding.
 *
 * Authentication: required.
 */

import { createRestoreHandler } from '@/lib/framework/obsiddy/api/handlers';
import { entityResource } from '@/lib/framework/obsiddy/services/resources';

export const { POST } = createRestoreHandler(entityResource);
