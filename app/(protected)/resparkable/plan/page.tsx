import type { Metadata } from 'next';
import { z } from 'zod';

import { DayPlanner } from '@/components/resparkable/plan/day-planner';
import { LoadError } from '@/components/resparkable/ui/load-error';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import {
  areaSchema,
  projectSchema,
  timeBlockSchema,
} from '@/lib/framework/resparkable/ui/payloads';
import { readResparkable } from '@/lib/framework/resparkable/ui/server-read';

export const metadata: Metadata = {
  title: 'Plan',
  description: 'Block out the time you actually have.',
};

/**
 * The day planner.
 *
 * The day comes from the URL so a particular day is shareable and the back button
 * behaves. An unparseable one falls back to today rather than erroring — a hand-edited
 * date should degrade, not break the page.
 *
 * The window is computed in **server** time here, which is a deliberate simplification:
 * the blocks it fetches are rendered with `<ClientDate>` in the browser's zone, so a
 * user a few hours from the server may see a block from the edge of the neighbouring
 * day. Getting this exactly right means resolving the day boundary in
 * `ResparkableSpace.timezone` (`time/zoned.ts` does it for snoozes), and it is worth doing
 * when the planner grows a week view. Recorded rather than hidden.
 */
export default async function ResparkablePlanPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = Array.isArray(params.day) ? params.day[0] : params.day;

  const day = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : todayIso();

  const from = new Date(`${day}T00:00:00`);
  const to = new Date(`${day}T23:59:59`);

  const query = new URLSearchParams({
    from: from.toISOString(),
    to: to.toISOString(),
    limit: '100',
  });

  const [blocks, projects, areas] = await Promise.all([
    readResparkable(`${RESPARKABLE_API.TIME_BLOCKS}?${query.toString()}`, z.array(timeBlockSchema)),
    readResparkable(`${RESPARKABLE_API.PROJECTS}?status=active&limit=200`, z.array(projectSchema)),
    readResparkable(`${RESPARKABLE_API.AREAS}?limit=200`, z.array(areaSchema)),
  ]);

  if (!blocks.ok) {
    return <LoadError what="your day" message={blocks.message} />;
  }

  return (
    // Keyed on the day so changing the date picker remounts the planner.
    // Switching day is a `router.push` to this same segment, so without the key
    // React reconciles rather than remounts, and `DayPlanner`'s `startAt`/`endAt`
    // — seeded from `day` in `useState` initialisers, which run once — keep
    // pointing at the day you just left. The block would then be written to the
    // previous day and vanish from the list you are looking at. Remounting also
    // clears the half-typed draft, which is the right call: a new day is a new
    // plan, not a continuation of the last one.
    <DayPlanner
      key={day}
      blocks={blocks.data}
      projects={projects.ok ? projects.data : []}
      areas={areas.ok ? areas.data : []}
      day={day}
    />
  );
}

function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const date = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${date}`;
}
