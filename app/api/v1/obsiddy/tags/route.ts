/**
 * GET  /api/v1/obsiddy/tags — list labels
 * POST /api/v1/obsiddy/tags — create one
 *
 * Tags are a table rather than a `String[]` column so renaming a label is one write
 * instead of five hundred, and so a label can carry a colour and be filtered on (§12).
 *
 * Authentication: required.
 */

import { createCollectionHandlers } from '@/lib/framework/obsiddy/api/handlers';
import { tagResource } from '@/lib/framework/obsiddy/services/resources';

export const { GET, POST } = createCollectionHandlers(tagResource);
