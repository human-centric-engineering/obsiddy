/**
 * POST /api/v1/resparkable/projects/:id/restore — clear archivedAt and re-enqueue
 * the item for embedding.
 *
 * Authentication: required.
 */

import { createRestoreHandler } from '@/lib/framework/resparkable/api/handlers';
import { projectResource } from '@/lib/framework/resparkable/services/resources';

export const { POST } = createRestoreHandler(projectResource);
