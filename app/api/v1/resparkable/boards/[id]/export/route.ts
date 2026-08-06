/**
 * GET /api/v1/resparkable/boards/[id]/export?format=csv|json
 *
 * CSV first because it is the generic answer: it imports into Trello Premium, Jira,
 * Asana, Notion and Linear alike, so "export to external boards" is satisfied once
 * rather than per vendor. JSON mirrors Trello's board shape for tooling (§12).
 *
 * **Every CSV cell goes through `csvEscape`.** A task titled
 * `=HYPERLINK("http://evil","Q4 plan")` is inert text in the database and a live
 * formula the moment the file opens in Excel or Sheets — a phishing vector delivered
 * through someone's own board. See `services/board-export.ts`.
 *
 * Owner-scoped and read-only. When sharing lands (Release 2), exporting a board
 * shared *with* you must stay refused, or a read grant becomes a data-extraction
 * tool against someone else's brain.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { validateQueryParams } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { PRIVATE_NO_CACHE } from '@/lib/framework/resparkable/api/cache';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { boardToCsv, boardToJson } from '@/lib/framework/resparkable/services/board-export';
import { buildBoardView } from '@/lib/framework/resparkable/services/board-view';
import { boardExportQuerySchema } from '@/lib/framework/resparkable/validations';

export const GET = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);
  const { id } = await params;

  const query = validateQueryParams(new URL(request.url).searchParams, boardExportQuerySchema);

  const view = await buildBoardView(scope, id);
  if (!view) throw new NotFoundError('board not found');

  log.info('Resparkable board exported', { format: query.format, cards: view.totalCards });

  // A file download rather than the API envelope: the caller asked for something to
  // open in another tool, and wrapping it in `{ success, data }` would mean every
  // consumer unwrapping it before they could use it.
  const filename = `${view.board.slug}.${query.format}`;

  if (query.format === 'json') {
    return new Response(JSON.stringify(boardToJson(view), null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': PRIVATE_NO_CACHE,
      },
    });
  }

  return new Response(boardToCsv(view), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': PRIVATE_NO_CACHE,
    },
  });
});
