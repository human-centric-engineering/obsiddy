/**
 * Space repo — the one table keyed by `userId` rather than scoped by it.
 *
 * `ObsiddySpace` is where a scope *comes from*, so its reads take a plain
 * verified `userId` instead of an `OwnerScope`: `ensureObsiddySpace()` runs
 * before there is a space to scope to. That is the single exception to the D5
 * signature rule, and it is why this file is short enough to audit at a glance.
 *
 * Lookup by `inboxToken` is the inbound-email entry point — the one place a
 * user id is *derived* from an attacker-supplied value rather than a session,
 * which is why the token is a 16-byte bearer credential and why the adapter
 * must still verify the sender (§17 risk 8).
 */

import { prisma } from '@/lib/db/client';
import { Prisma, type ObsiddySpace } from '@prisma/client';

export async function findSpaceByUserId(userId: string): Promise<ObsiddySpace | null> {
  return prisma.obsiddySpace.findUnique({ where: { userId } });
}

export async function findSpaceByToken(inboxToken: string): Promise<ObsiddySpace | null> {
  return prisma.obsiddySpace.findUnique({ where: { inboxToken } });
}

export async function createSpace(data: {
  userId: string;
  inboxToken: string;
}): Promise<ObsiddySpace> {
  return prisma.obsiddySpace.create({ data });
}

/** The settings patch in domain terms — `null` means "reset me to the defaults". */
export interface SpaceSettingsPatch {
  timezone?: string;
  weeklyCapacityMinutes?: number;
  workStyle?: string;
  priorityWeights?: object | null;
  energyProfile?: object | null;
  retentionPolicy?: object | null;
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
): Promise<ObsiddySpace> {
  const data: Prisma.ObsiddySpaceUncheckedUpdateInput = {};

  if (patch.timezone !== undefined) data.timezone = patch.timezone;
  if (patch.weeklyCapacityMinutes !== undefined) {
    data.weeklyCapacityMinutes = patch.weeklyCapacityMinutes;
  }
  if (patch.workStyle !== undefined) data.workStyle = patch.workStyle;
  if (patch.priorityWeights !== undefined) data.priorityWeights = jsonOrNull(patch.priorityWeights);
  if (patch.energyProfile !== undefined) data.energyProfile = jsonOrNull(patch.energyProfile);
  if (patch.retentionPolicy !== undefined) data.retentionPolicy = jsonOrNull(patch.retentionPolicy);

  return prisma.obsiddySpace.update({ where: { userId }, data });
}

function jsonOrNull(value: object | null): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null ? Prisma.DbNull : value;
}
