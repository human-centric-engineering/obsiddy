import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import { ProjectDetail } from '@/components/obsiddy/projects/project-detail';
import { LoadError } from '@/components/obsiddy/ui/load-error';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';
import { areaSchema, projectViewSchema } from '@/lib/framework/obsiddy/ui/payloads';
import { readObsiddy } from '@/lib/framework/obsiddy/ui/server-read';

export const metadata: Metadata = {
  title: 'Project',
};

/**
 * One project.
 *
 * `/projects/[id]/view` returns the project, its area, its tasks in score order,
 * counts and its connections in a single request — see `services/details.ts` for why
 * that is a sibling route rather than an `?include=`.
 *
 * A 404 becomes `notFound()`, which is the same response the API gives for another
 * user's id. That is the isolation contract surfacing correctly: "not yours" and
 * "doesn't exist" must be indistinguishable, including in the UI.
 */
export default async function ObsiddyProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [view, areas] = await Promise.all([
    readObsiddy(OBSIDDY_API.viewPath(OBSIDDY_API.PROJECTS, id), projectViewSchema),
    readObsiddy(`${OBSIDDY_API.AREAS}?limit=200`, z.array(areaSchema)),
  ]);

  if (!view.ok) {
    if (view.status === 404) notFound();
    return <LoadError what="this project" message={view.message} />;
  }

  return <ProjectDetail view={view.data} areas={areas.ok ? areas.data : []} />;
}
