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
import type { ObsiddySpace, Prisma } from '@prisma/client';

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

export async function updateSpace(
  userId: string,
  data: Omit<Prisma.ObsiddySpaceUncheckedUpdateInput, 'id' | 'userId' | 'inboxToken'>
): Promise<ObsiddySpace> {
  return prisma.obsiddySpace.update({ where: { userId }, data });
}
