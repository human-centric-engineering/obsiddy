/**
 * Obsiddy's capability registrations.
 *
 * Called from `lib/app/capabilities.ts` — the fork-owned scaffold Sunrise ships
 * empty and never touches again, so this stays a one-line edit that survives
 * every upstream merge. Obsiddy touches zero Sunrise-owned files, and a
 * capability list is not a reason to break that.
 *
 * **Where this runs matters.** `registerBuiltInCapabilities()` calls
 * `initAppCapabilities()` lazily, in the server route-handler realm, immediately
 * before the first dispatch — not at boot. That is the fix for
 * [sunrise#462](https://github.com/human-centric-engineering/sunrise/issues/462),
 * where boot-registered capabilities were silently lost at request time under
 * Turbopack because the two realms hold separate module graphs. So this function
 * must stay cheap and synchronous: it constructs fourteen objects and pushes
 * them into a map, and does not touch the database.
 *
 * **Registration is not availability.** A registered capability still needs an
 * active `AiCapability` row (seed `001-capabilities`) and an `AiAgentCapability`
 * binding (seed `004-agent-capabilities`) before any agent can call it — the
 * dispatcher gates on both. Registering without seeding gives you a handler the
 * dispatcher refuses at `capability_inactive`, which is the right failure: an
 * operator who deactivated a tool in the admin UI has deactivated it.
 */

import { ObsiddyCaptureCapability } from '@/lib/framework/obsiddy/capabilities/capture';
import { ObsiddyGetSnapshotCapability } from '@/lib/framework/obsiddy/capabilities/snapshot';
import { ObsiddyIdeateCapability } from '@/lib/framework/obsiddy/capabilities/ideate';
import {
  ObsiddyFindConnectionsCapability,
  ObsiddyLinkEntitiesCapability,
} from '@/lib/framework/obsiddy/capabilities/links';
import {
  ObsiddyUpsertEntityCapability,
  ObsiddyUpsertGoalCapability,
  ObsiddyUpsertProjectCapability,
} from '@/lib/framework/obsiddy/capabilities/records';
import { ObsiddyPromoteThoughtCapability } from '@/lib/framework/obsiddy/capabilities/promote';
import { ObsiddyReprioritiseCapability } from '@/lib/framework/obsiddy/capabilities/reprioritise';
import { ObsiddyWriteReviewCapability } from '@/lib/framework/obsiddy/capabilities/reviews';
import { ObsiddySearchCapability } from '@/lib/framework/obsiddy/capabilities/search';
import {
  ObsiddyListTasksCapability,
  ObsiddyUpsertTaskCapability,
} from '@/lib/framework/obsiddy/capabilities/tasks';
import { registerAppCapability } from '@/lib/orchestration/capabilities';
import type { BaseCapability } from '@/lib/orchestration/capabilities';

/**
 * Every Obsiddy capability handler, constructed fresh.
 *
 * A function rather than a module-level array so a test can build the set twice
 * without sharing instances, and so the constructors (which read their own
 * catalogue entry and throw on a missing slug) run inside the caller's stack
 * rather than at import time.
 */
export function obsiddyCapabilityHandlers(): BaseCapability[] {
  return [
    new ObsiddyCaptureCapability(),
    new ObsiddySearchCapability(),
    new ObsiddyListTasksCapability(),
    new ObsiddyPromoteThoughtCapability(),
    new ObsiddyUpsertTaskCapability(),
    new ObsiddyUpsertProjectCapability(),
    new ObsiddyUpsertGoalCapability(),
    new ObsiddyUpsertEntityCapability(),
    new ObsiddyLinkEntitiesCapability(),
    new ObsiddyFindConnectionsCapability(),
    new ObsiddyGetSnapshotCapability(),
    new ObsiddyWriteReviewCapability(),
    new ObsiddyReprioritiseCapability(),
    new ObsiddyIdeateCapability(),
  ];
}

/** Register the fourteen. Idempotent — the registry keys on slug. */
export function registerObsiddyCapabilities(): void {
  for (const capability of obsiddyCapabilityHandlers()) {
    registerAppCapability(capability);
  }
}
