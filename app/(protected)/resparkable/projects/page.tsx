import type { Metadata } from 'next';
import { z } from 'zod';

import { ProjectsView } from '@/components/resparkable/projects/projects-view';
import { LoadError } from '@/components/resparkable/ui/load-error';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { areaSchema, projectSchema } from '@/lib/framework/resparkable/ui/payloads';
import { readResparkable } from '@/lib/framework/resparkable/ui/server-read';
import { PROJECT_STATUSES } from '@/lib/framework/resparkable/validations';

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
export default async function ResparkableProjectsPage({
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
    readResparkable(`${RESPARKABLE_API.PROJECTS}?${query.toString()}`, z.array(projectSchema)),
    readResparkable(`${RESPARKABLE_API.AREAS}?limit=200`, z.array(areaSchema)),
  ]);

  if (!projects.ok) {
    return <LoadError what="your projects" message={projects.message} />;
  }

  return (
    <ProjectsView projects={projects.data} areas={areas.ok ? areas.data : []} status={status} />
  );
}
