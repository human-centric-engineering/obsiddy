import type { Metadata } from 'next';
import { z } from 'zod';

import { GoalsView } from '@/components/resparkable/goals/goals-view';
import { LoadError } from '@/components/resparkable/ui/load-error';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { areaSchema, goalSchema } from '@/lib/framework/resparkable/ui/payloads';
import { readResparkable } from '@/lib/framework/resparkable/ui/server-read';

export const metadata: Metadata = {
  title: 'Goals',
  description: 'What you want to be true, and by when.',
};

/**
 * Goals, as a tree.
 *
 * The whole set is fetched in one request and nested client-side. That is right here
 * and would be wrong for tasks: goals are few (tens, not thousands), the hierarchy is
 * the content, and building it server-side would mean a recursive query to save
 * nothing.
 */
export default async function ResparkableGoalsPage() {
  const [goals, areas] = await Promise.all([
    readResparkable(`${RESPARKABLE_API.GOALS}?limit=200`, z.array(goalSchema)),
    readResparkable(`${RESPARKABLE_API.AREAS}?limit=200`, z.array(areaSchema)),
  ]);

  if (!goals.ok) {
    return <LoadError what="your goals" message={goals.message} />;
  }

  return <GoalsView goals={goals.data} areas={areas.ok ? areas.data : []} />;
}
