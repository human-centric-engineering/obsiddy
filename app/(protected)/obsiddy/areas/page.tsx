import type { Metadata } from 'next';
import { z } from 'zod';

import { AreasView } from '@/components/obsiddy/areas/areas-view';
import { LoadError } from '@/components/obsiddy/ui/load-error';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';
import { areaSchema } from '@/lib/framework/obsiddy/ui/payloads';
import { readObsiddy } from '@/lib/framework/obsiddy/ui/server-read';

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

export default async function ObsiddyAreasPage() {
  const [areas, space] = await Promise.all([
    readObsiddy(`${OBSIDDY_API.AREAS}?limit=200`, z.array(areaSchema)),
    readObsiddy(OBSIDDY_API.SPACE, spaceSchema),
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
