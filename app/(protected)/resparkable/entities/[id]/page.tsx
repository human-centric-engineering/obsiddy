import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { EntityDetail } from '@/components/resparkable/entities/entity-detail';
import { LoadError } from '@/components/resparkable/ui/load-error';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { entityViewSchema } from '@/lib/framework/resparkable/ui/payloads';
import { readResparkable } from '@/lib/framework/resparkable/ui/server-read';

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
export default async function ResparkableEntityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const view = await readResparkable(
    RESPARKABLE_API.viewPath(RESPARKABLE_API.ENTITIES, id),
    entityViewSchema
  );

  if (!view.ok) {
    if (view.status === 404) notFound();
    return <LoadError what="this person or company" message={view.message} />;
  }

  return <EntityDetail view={view.data} />;
}
