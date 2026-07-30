import type { Metadata } from 'next';
import { z } from 'zod';

import { BoardsList } from '@/components/obsiddy/board/boards-list';
import { LoadError } from '@/components/obsiddy/ui/load-error';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';
import { boardSchema, projectSchema, tagSchema } from '@/lib/framework/obsiddy/ui/payloads';
import { readObsiddy } from '@/lib/framework/obsiddy/ui/server-read';

export const metadata: Metadata = {
  title: 'Boards',
  description: 'Kanban views over the tasks you already have.',
};

/**
 * Boards, plus the shared label library.
 *
 * Three fetches for the page — boards, projects for the filter picker, tags for the
 * library — issued concurrently. None per row.
 */
export default async function ObsiddyBoardsPage() {
  const [boards, projects, tags] = await Promise.all([
    readObsiddy(`${OBSIDDY_API.BOARDS}?limit=100`, z.array(boardSchema)),
    readObsiddy(`${OBSIDDY_API.PROJECTS}?status=active&limit=200`, z.array(projectSchema)),
    readObsiddy(`${OBSIDDY_API.TAGS}?limit=100`, z.array(tagSchema)),
  ]);

  if (!boards.ok) {
    return <LoadError what="your boards" message={boards.message} />;
  }

  return (
    <BoardsList
      boards={boards.data}
      projects={projects.ok ? projects.data : []}
      tags={tags.ok ? tags.data : []}
    />
  );
}
