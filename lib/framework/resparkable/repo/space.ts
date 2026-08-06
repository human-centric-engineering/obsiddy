/**
 * Space repo — the one table keyed by `userId` rather than scoped by it.
 *
 * `ResparkableSpace` is where a scope *comes from*, so its reads take a plain
 * verified `userId` instead of an `OwnerScope`: `ensureResparkableSpace()` runs
 * before there is a space to scope to. That is the single exception to the D5
 * signature rule, and it is why this file is short enough to audit at a glance.
 *
 * Lookup by `inboxToken` is the inbound-email entry point — the one place a
 * user id is *derived* from an attacker-supplied value rather than a session,
 * which is why the token is a 16-byte bearer credential and why the adapter
 * must still verify the sender (§17 risk 8).
 */

import { prisma } from '@/lib/db/client';
import { Prisma, type ResparkableSpace } from '@prisma/client';

export async function findSpaceByUserId(userId: string): Promise<ResparkableSpace | null> {
  return prisma.resparkableSpace.findUnique({ where: { userId } });
}

export async function findSpaceByToken(inboxToken: string): Promise<ResparkableSpace | null> {
  return prisma.resparkableSpace.findUnique({ where: { inboxToken } });
}

export async function createSpace(data: {
  userId: string;
  inboxToken: string;
}): Promise<ResparkableSpace> {
  return prisma.resparkableSpace.create({ data });
}

/** One brain's turn in the rotation: who, and the zone their schedules run in. */
export interface SpaceDueSweep {
  userId: string;
  timezone: string;
}

/**
 * The next brains due a connection sweep, oldest-swept first.
 *
 * **The one unscoped read in the tier, and it is unscoped by necessity rather
 * than by omission.** `registerAppJob` fires a single process-wide callback, so
 * something has to answer "whose brain next?" — a question no `OwnerScope` can
 * express. It is safe precisely because of how little it returns: a user id and
 * the zone their schedules are built in, and no brain content whatsoever. Each
 * id is then minted into its own scope and every subsequent read goes back
 * through the normal owner-scoped path (D5 is untouched — this chooses a scope,
 * it does not bypass one).
 *
 * `timezone` rides along because the tick is also where `ensureResparkableSchedules`
 * reaches existing brains, and it takes the zone as an argument rather than
 * looking it up — deliberately, to keep `services/space` and `schedules/ensure`
 * out of an import cycle. One extra column on a query already being made is the
 * cheapest way to honour that; the alternative is a second read per brain.
 *
 * **`nulls: 'first'` is not optional, and omitting it inverts the whole
 * rotation.** Postgres sorts nulls as *larger* than any non-null value, so plain
 * `ASC` means `NULLS LAST` — a never-swept brain would sort behind every swept
 * one. The failure is not a slow rotation but a stalled one: every row starts
 * null, the first tick stamps a batch, and from the second tick those stamped
 * rows sort ahead of all the nulls and are returned again for ever, while no
 * brain that has never been swept is ever reached. That is exactly the
 * "re-examine the same N and leave the rest unreachable" bug this cursor exists
 * to prevent, one level up — and the tier's own per-type cursor
 * (`repo/embeddings.ts`) already spells the option out for the same reason.
 *
 * A never-swept brain is the most overdue one there is, so it must sort first.
 */
export async function listSpacesDueSweep(limit: number): Promise<SpaceDueSweep[]> {
  return prisma.resparkableSpace.findMany({
    select: { userId: true, timezone: true },
    orderBy: { lastSweptAt: { sort: 'asc', nulls: 'first' } },
    take: limit,
  });
}

/**
 * Stamp the rotation cursor for the brains just swept.
 *
 * `updateMany` rather than a batch of `update` calls, and that is deliberate for
 * the reason ask #17 records: a scoped `update` throws `P2025` when the row is
 * gone, so a user erased mid-sweep would fail the whole job after the work was
 * already done. A miss here is zero rows, which is the correct outcome — there
 * is nothing left to stamp.
 */
export async function markSpacesSwept(userIds: string[], at: Date): Promise<number> {
  if (userIds.length === 0) return 0;
  const { count } = await prisma.resparkableSpace.updateMany({
    where: { userId: { in: userIds } },
    data: { lastSweptAt: at },
  });
  return count;
}

/** The settings patch in domain terms — `null` means "reset me to the defaults". */
export interface SpaceSettingsPatch {
  timezone?: string;
  weeklyCapacityMinutes?: number;
  workStyle?: string;
  priorityWeights?: object | null;
  energyProfile?: object | null;
  retentionPolicy?: object | null;
  /**
   * Nullable scalar, not a `Json` column — so a plain `null` reaches SQL as NULL
   * and needs none of the `Prisma.DbNull` translation below. `null` means "use
   * the code default" (`STRENGTH_FLOOR`), matching the migration's reasoning.
   */
  connectionStrengthFloor?: number | null;
}

/**
 * Update the settings columns, translating `null` into a real SQL NULL.
 *
 * Prisma will not accept a bare `null` for a nullable `Json` column: it demands
 * `Prisma.DbNull` (the column is NULL) or `Prisma.JsonNull` (the column holds
 * the JSON value `null`) — a distinction that only exists because JSON has its
 * own null. `DbNull` is the one we want, and it is the difference between
 * `customised: false` and `customised: true` on the settings payload.
 *
 * The translation lives here because `Prisma.DbNull` is a runtime value, and the
 * tier's lint boundary allows the Prisma client only inside `repo/**`. A service
 * would have to import it to express the same thing.
 */
export async function updateSpaceSettings(
  userId: string,
  patch: SpaceSettingsPatch
): Promise<ResparkableSpace> {
  const data: Prisma.ResparkableSpaceUncheckedUpdateInput = {};

  if (patch.timezone !== undefined) data.timezone = patch.timezone;
  if (patch.weeklyCapacityMinutes !== undefined) {
    data.weeklyCapacityMinutes = patch.weeklyCapacityMinutes;
  }
  if (patch.workStyle !== undefined) data.workStyle = patch.workStyle;
  if (patch.priorityWeights !== undefined) data.priorityWeights = jsonOrNull(patch.priorityWeights);
  if (patch.energyProfile !== undefined) data.energyProfile = jsonOrNull(patch.energyProfile);
  if (patch.retentionPolicy !== undefined) data.retentionPolicy = jsonOrNull(patch.retentionPolicy);
  if (patch.connectionStrengthFloor !== undefined) {
    data.connectionStrengthFloor = patch.connectionStrengthFloor;
  }

  return prisma.resparkableSpace.update({ where: { userId }, data });
}

function jsonOrNull(value: object | null): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null ? Prisma.DbNull : value;
}
