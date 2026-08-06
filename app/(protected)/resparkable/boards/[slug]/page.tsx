import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Download } from 'lucide-react';
import { z } from 'zod';

import { BoardView } from '@/components/resparkable/board/board-view';
import { LoadError } from '@/components/resparkable/ui/load-error';
import { Button } from '@/components/ui/button';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { boardSchema, boardViewSchema, tagSchema } from '@/lib/framework/resparkable/ui/payloads';
import { readResparkable } from '@/lib/framework/resparkable/ui/server-read';

export const metadata: Metadata = {
  title: 'Board',
};

/**
 * One board.
 *
 * ## Slug in the URL, id in the API
 *
 * A board URL is something people keep — a bookmark, a link in a note — so it reads
 * rather than carrying a cuid. The `/view` endpoint is addressed by id, so the slug is
 * resolved from the board list first. That is one extra request on a page that is
 * otherwise a single fetch, and it buys a URL that survives being shared.
 *
 * Everything else comes from `/boards/[id]/view`: columns, cards, each card's tags and
 * checklist, WIP breaches. A board is where an N+1 is most visible, so nothing here
 * fetches per card.
 */
export default async function ResparkableBoardPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  // Resolved client-side of the API rather than adding a by-slug endpoint: one list
  // read, and the id never appears in a URL anybody sees.
  const boards = await readResparkable(`${RESPARKABLE_API.BOARDS}?limit=200`, z.array(boardSchema));
  if (!boards.ok) {
    return <LoadError what="this board" message={boards.message} />;
  }

  const board = boards.data.find((entry) => entry.slug === slug);
  if (!board) notFound();

  const [view, tags] = await Promise.all([
    readResparkable(RESPARKABLE_API.viewPath(RESPARKABLE_API.BOARDS, board.id), boardViewSchema),
    readResparkable(`${RESPARKABLE_API.TAGS}?limit=100`, z.array(tagSchema)),
  ]);

  if (!view.ok) {
    if (view.status === 404) notFound();
    return <LoadError what="this board" message={view.message} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          {/* h2 — the shell's section header is this page's h1 ("Boards"), and
              this board is one of them. */}
          <h2 className="text-lg font-semibold">{view.data.board.name}</h2>
          <p className="text-muted-foreground text-xs">
            {view.data.totalCards} {view.data.totalCards === 1 ? 'card' : 'cards'} ·{' '}
            {view.data.board.membership === 'explicit'
              ? 'hand-picked, in the order you set'
              : 'a live query, ordered by what matters most'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Plain links: the endpoint returns a file with a Content-Disposition,
              so the browser downloads it without any client code. */}
          <Button asChild variant="outline" size="sm">
            <a href={RESPARKABLE_API.boardExport(view.data.board.id, 'csv')}>
              <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              CSV
            </a>
          </Button>
          <Button asChild variant="outline" size="sm">
            <a href={RESPARKABLE_API.boardExport(view.data.board.id, 'json')}>
              <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              JSON
            </a>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href="/resparkable/boards">All boards</Link>
          </Button>
        </div>
      </div>

      <BoardView view={view.data} allTags={tags.ok ? tags.data : []} />
    </div>
  );
}
