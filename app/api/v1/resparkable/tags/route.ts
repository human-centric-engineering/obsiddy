/**
 * GET  /api/v1/resparkable/tags — list labels
 * POST /api/v1/resparkable/tags — create one
 *
 * Tags are a table rather than a `String[]` column so renaming a label is one write
 * instead of five hundred, and so a label can carry a colour and be filtered on (§12).
 *
 * Authentication: required.
 */

import { createCollectionHandlers } from '@/lib/framework/resparkable/api/handlers';
import { tagResource } from '@/lib/framework/resparkable/services/resources';

export const { GET, POST } = createCollectionHandlers(tagResource);
