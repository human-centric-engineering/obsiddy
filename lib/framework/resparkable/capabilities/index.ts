/**
 * Resparkable's capability registrations.
 *
 * Called from `lib/app/capabilities.ts` — the fork-owned scaffold Resparkable ships
 * empty and never touches again, so this stays a one-line edit that survives
 * every upstream merge. Resparkable touches zero Sunrise-owned files, and a
 * capability list is not a reason to break that.
 *
 * **Where this runs matters.** `registerBuiltInCapabilities()` calls
 * `initAppCapabilities()` lazily, in the server route-handler realm, immediately
 * before the first dispatch — not at boot. That is the fix for
 * [resparkable#462](https://github.com/human-centric-engineering/sunrise/issues/462),
 * where boot-registered capabilities were silently lost at request time under
 * Turbopack because the two realms hold separate module graphs. So this function
 * must stay cheap and synchronous: it constructs seventeen objects and pushes
 * them into a map, and does not touch the database.
 *
 * **Registration is not availability.** A registered capability still needs an
 * active `AiCapability` row (seed `001-capabilities`) and an `AiAgentCapability`
 * binding (seed `004-agent-capabilities`) before any agent can call it — the
 * dispatcher gates on both. Registering without seeding gives you a handler the
 * dispatcher refuses at `capability_inactive`, which is the right failure: an
 * operator who deactivated a tool in the admin UI has deactivated it.
 */

import {
  ResparkableGetBriefingCapability,
  ResparkableGetBriefingInputsCapability,
} from '@/lib/framework/resparkable/capabilities/briefing';
import { ResparkableCaptureCapability } from '@/lib/framework/resparkable/capabilities/capture';
import { ResparkableGetSnapshotCapability } from '@/lib/framework/resparkable/capabilities/snapshot';
import { ResparkableIdeateCapability } from '@/lib/framework/resparkable/capabilities/ideate';
import { ResparkableNotifyCapability } from '@/lib/framework/resparkable/capabilities/notify';
import {
  ResparkableFindConnectionsCapability,
  ResparkableLinkEntitiesCapability,
} from '@/lib/framework/resparkable/capabilities/links';
import {
  ResparkableUpsertEntityCapability,
  ResparkableUpsertGoalCapability,
  ResparkableUpsertProjectCapability,
} from '@/lib/framework/resparkable/capabilities/records';
import { ResparkablePromoteThoughtCapability } from '@/lib/framework/resparkable/capabilities/promote';
import { ResparkableReprioritiseCapability } from '@/lib/framework/resparkable/capabilities/reprioritise';
import { ResparkableWriteReviewCapability } from '@/lib/framework/resparkable/capabilities/reviews';
import { ResparkableSearchCapability } from '@/lib/framework/resparkable/capabilities/search';
import { ResparkableGetStaleDigestCapability } from '@/lib/framework/resparkable/capabilities/stale';
import {
  ResparkableListTasksCapability,
  ResparkableUpsertTaskCapability,
} from '@/lib/framework/resparkable/capabilities/tasks';
import { registerAppCapability } from '@/lib/orchestration/capabilities';
import type { BaseCapability } from '@/lib/orchestration/capabilities';

/**
 * Every Resparkable capability handler, constructed fresh.
 *
 * A function rather than a module-level array so a test can build the set twice
 * without sharing instances, and so the constructors (which read their own
 * catalogue entry and throw on a missing slug) run inside the caller's stack
 * rather than at import time.
 */
export function resparkableCapabilityHandlers(): BaseCapability[] {
  return [
    new ResparkableCaptureCapability(),
    new ResparkableSearchCapability(),
    new ResparkableListTasksCapability(),
    new ResparkablePromoteThoughtCapability(),
    new ResparkableUpsertTaskCapability(),
    new ResparkableUpsertProjectCapability(),
    new ResparkableUpsertGoalCapability(),
    new ResparkableUpsertEntityCapability(),
    new ResparkableLinkEntitiesCapability(),
    new ResparkableFindConnectionsCapability(),
    new ResparkableGetSnapshotCapability(),
    new ResparkableWriteReviewCapability(),
    new ResparkableReprioritiseCapability(),
    new ResparkableIdeateCapability(),
    new ResparkableGetBriefingCapability(),
    new ResparkableGetBriefingInputsCapability(),
    new ResparkableNotifyCapability(),
    new ResparkableGetStaleDigestCapability(),
  ];
}

/** Register the eighteen. Idempotent — the registry keys on slug. */
export function registerResparkableCapabilities(): void {
  for (const capability of resparkableCapabilityHandlers()) {
    registerAppCapability(capability);
  }
}
