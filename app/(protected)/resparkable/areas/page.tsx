import type { Metadata } from 'next';
import { z } from 'zod';

import { AreasView } from '@/components/resparkable/areas/areas-view';
import { LoadError } from '@/components/resparkable/ui/load-error';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { areaSchema } from '@/lib/framework/resparkable/ui/payloads';
import { readResparkable } from '@/lib/framework/resparkable/ui/server-read';

export const metadata: Metadata = {
  title: 'Areas',
  description: 'The standing parts of your life, and how much of your week each gets.',
};

/**
 * Areas.
 *
 * The space settings are fetched alongside them so the page can compare the sum of
 * every weekly target against the actual weekly capacity. Targets adding up to more
 * hours than the week has makes every area read as neglected, which flattens the
 * balancing instead of sharpening it — worth surfacing, and impossible to see from
 * the areas alone.
 */
const spaceSchema = z.object({ weeklyCapacityMinutes: z.number() });

export default async function ResparkableAreasPage() {
  const [areas, space] = await Promise.all([
    readResparkable(`${RESPARKABLE_API.AREAS}?limit=200`, z.array(areaSchema)),
    readResparkable(RESPARKABLE_API.SPACE, spaceSchema),
  ]);

  if (!areas.ok) {
    return <LoadError what="your areas" message={areas.message} />;
  }

  return (
    <AreasView
      areas={areas.data}
      weeklyCapacityMinutes={space.ok ? space.data.weeklyCapacityMinutes : null}
    />
  );
}
