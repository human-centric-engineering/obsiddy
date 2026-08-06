/**
 * POST /api/v1/resparkable/areas/:id/restore — clear archivedAt and re-enqueue
 * the item for embedding.
 *
 * Authentication: required.
 */

import { createRestoreHandler } from '@/lib/framework/resparkable/api/handlers';
import { areaResource } from '@/lib/framework/resparkable/services/resources';

export const { POST } = createRestoreHandler(areaResource);
