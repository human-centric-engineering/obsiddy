import type { Metadata } from 'next';
import { z } from 'zod';

import { EntitiesView } from '@/components/obsiddy/entities/entities-view';
import { LoadError } from '@/components/obsiddy/ui/load-error';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';
import { entitySchema } from '@/lib/framework/obsiddy/ui/payloads';
import { readObsiddy } from '@/lib/framework/obsiddy/ui/server-read';

export const metadata: Metadata = {
  title: 'People',
  description: 'The people, companies and markets your work involves.',
};

export default async function ObsiddyEntitiesPage() {
  const entities = await readObsiddy(`${OBSIDDY_API.ENTITIES}?limit=200`, z.array(entitySchema));

  if (!entities.ok) {
    return <LoadError what="your people and companies" message={entities.message} />;
  }

  return <EntitiesView entities={entities.data} />;
}
