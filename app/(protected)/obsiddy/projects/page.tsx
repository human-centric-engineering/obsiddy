import type { Metadata } from 'next';
import { z } from 'zod';

import { ProjectsView } from '@/components/obsiddy/projects/projects-view';
import { LoadError } from '@/components/obsiddy/ui/load-error';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';
import { areaSchema, projectSchema } from '@/lib/framework/obsiddy/ui/payloads';
import { readObsiddy } from '@/lib/framework/obsiddy/ui/server-read';
import { PROJECT_STATUSES } from '@/lib/framework/obsiddy/validations';

export const metadata: Metadata = {
  title: 'Projects',
  description: 'Bodies of work, and what each is connected to.',
};

/**
 * Projects.
 *
 * Two fetches for the page — the projects, and the areas the filter and the create
 * form need — issued concurrently. Never one per row.
 *
 * The status filter is read from the URL and passed to the API rather than applied
 * in memory: the server holds the authoritative list, and filtering a page of 50
 * client-side would quietly hide rows 51+ that matched.
 */
export default async function ObsiddyProjectsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = Array.isArray(params.status) ? params.status[0] : params.status;
  // An unrecognised status is dropped rather than passed on — the API would 400,
  // and a hand-edited URL should degrade to "everything", not to an error page.
  const status = raw && (PROJECT_STATUSES as readonly string[]).includes(raw) ? raw : null;

  const query = new URLSearchParams({ limit: '200' });
  if (status) query.set('status', status);

  const [projects, areas] = await Promise.all([
    readObsiddy(`${OBSIDDY_API.PROJECTS}?${query.toString()}`, z.array(projectSchema)),
    readObsiddy(`${OBSIDDY_API.AREAS}?limit=200`, z.array(areaSchema)),
  ]);

  if (!projects.ok) {
    return <LoadError what="your projects" message={projects.message} />;
  }

  return (
    <ProjectsView projects={projects.data} areas={areas.ok ? areas.data : []} status={status} />
  );
}
