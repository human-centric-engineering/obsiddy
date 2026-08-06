/**
 * POST /api/v1/resparkable/tasks/:id/restore — clear archivedAt and re-enqueue
 * the item for embedding.
 *
 * Authentication: required.
 */

import { createRestoreHandler } from '@/lib/framework/resparkable/api/handlers';
import { taskResource } from '@/lib/framework/resparkable/services/resources';

export const { POST } = createRestoreHandler(taskResource);
