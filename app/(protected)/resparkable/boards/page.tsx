import type { Metadata } from 'next';
import { z } from 'zod';

import { BoardsList } from '@/components/resparkable/board/boards-list';
import { LoadError } from '@/components/resparkable/ui/load-error';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { boardSchema, projectSchema, tagSchema } from '@/lib/framework/resparkable/ui/payloads';
import { readResparkable } from '@/lib/framework/resparkable/ui/server-read';

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
export default async function ResparkableBoardsPage() {
  const [boards, projects, tags] = await Promise.all([
    readResparkable(`${RESPARKABLE_API.BOARDS}?limit=100`, z.array(boardSchema)),
    readResparkable(`${RESPARKABLE_API.PROJECTS}?status=active&limit=200`, z.array(projectSchema)),
    readResparkable(`${RESPARKABLE_API.TAGS}?limit=100`, z.array(tagSchema)),
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
