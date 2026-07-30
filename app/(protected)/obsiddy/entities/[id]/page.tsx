import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { EntityDetail } from '@/components/obsiddy/entities/entity-detail';
import { LoadError } from '@/components/obsiddy/ui/load-error';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';
import { entityViewSchema } from '@/lib/framework/obsiddy/ui/payloads';
import { readObsiddy } from '@/lib/framework/obsiddy/ui/server-read';

export const metadata: Metadata = {
  title: 'Person or company',
};

/**
 * One entity, and everything linked to it.
 *
 * A 404 becomes `notFound()` — the same response the API gives for another user's id,
 * because "not yours" and "doesn't exist" must be indistinguishable all the way to
 * the surface.
 */
export default async function ObsiddyEntityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const view = await readObsiddy(OBSIDDY_API.viewPath(OBSIDDY_API.ENTITIES, id), entityViewSchema);

  if (!view.ok) {
    if (view.status === 404) notFound();
    return <LoadError what="this person or company" message={view.message} />;
  }

  return <EntityDetail view={view.data} />;
}
