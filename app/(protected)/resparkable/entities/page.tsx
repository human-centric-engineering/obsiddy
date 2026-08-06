import type { Metadata } from 'next';
import { z } from 'zod';

import { EntitiesView } from '@/components/resparkable/entities/entities-view';
import { LoadError } from '@/components/resparkable/ui/load-error';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { entitySchema } from '@/lib/framework/resparkable/ui/payloads';
import { readResparkable } from '@/lib/framework/resparkable/ui/server-read';

export const metadata: Metadata = {
  title: 'People',
  description: 'The people, companies and markets your work involves.',
};

export default async function ResparkableEntitiesPage() {
  const entities = await readResparkable(
    `${RESPARKABLE_API.ENTITIES}?limit=200`,
    z.array(entitySchema)
  );

  if (!entities.ok) {
    return <LoadError what="your people and companies" message={entities.message} />;
  }

  return <EntitiesView entities={entities.data} />;
}
