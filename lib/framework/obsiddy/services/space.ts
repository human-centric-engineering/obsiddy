/**
 * `ObsiddySpace` — the satellite row every other Obsiddy table hangs off (D1).
 *
 * One row per user, carrying the settings that are genuinely per-person:
 * timezone (snooze presets and retention windows resolve there, never in server
 * time), weekly capacity, scorer weights, retention windows, work style, and
 * the inbox token that routes captured email.
 *
 * **Everything else in the brain requires this row to exist**, because the
 * hand-written FK cascade (probe B1) runs `user → space → everything`. So
 * `ensureObsiddySpace()` is called at the top of any flow that can be a user's
 * first interaction — first page load, first capture, first agent turn — rather
 * than at signup. Sunrise has no fork-owned hook at user creation (upstream
 * #464), and hanging the brain off one would in any case leave every user who
 * predates the install without a space.
 */

import { randomBytes } from 'node:crypto';

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import type { ObsiddySpace } from '@prisma/client';

/**
 * 16 bytes of hex. This lands in an email address
 * (`brain+<inboxToken>@<OBSIDDY_INBOX_DOMAIN>`), so anyone who learns it can
 * inject thoughts into that user's brain — it is a bearer credential and is
 * sized accordingly (§17 risk 8). Hex rather than base64url because it has to
 * survive mail systems that lowercase the local part.
 */
const INBOX_TOKEN_BYTES = 16;

function generateInboxToken(): string {
  return randomBytes(INBOX_TOKEN_BYTES).toString('hex');
}

/**
 * Get the caller's space, creating it on first use.
 *
 * Idempotent and safe under concurrency: two parallel first-requests race on
 * `userId @unique`, the loser catches the constraint violation and re-reads.
 * That is deliberate rather than a transaction — the create is a single
 * statement and the read-after-conflict is the cheapest correct resolution.
 *
 * @param userId - **Always** from the verified session or `CapabilityContext`,
 *   never from a request body or an LLM-supplied argument (D5, §17 risk 6d).
 */
export async function ensureObsiddySpace(userId: string): Promise<ObsiddySpace> {
  if (!userId) {
    throw new Error('ensureObsiddySpace: userId is required');
  }

  const existing = await prisma.obsiddySpace.findUnique({ where: { userId } });
  if (existing) return existing;

  try {
    const created = await prisma.obsiddySpace.create({
      data: { userId, inboxToken: generateInboxToken() },
    });

    // Defaults for timezone, weights and retention live in code, not in this
    // row — a new scorer factor or retention window must not need a backfill.
    logger.info('Obsiddy space created', { userId, spaceId: created.id });

    // Phase 7 hooks `ensureObsiddySchedules(userId)` in here, so a user's
    // background workflows start the moment their brain exists.

    return created;
  } catch (error) {
    // Lost the race — the other request created it. Any other failure rethrows.
    if (isUniqueConstraintViolation(error)) {
      const raced = await prisma.obsiddySpace.findUnique({ where: { userId } });
      if (raced) return raced;
    }
    throw error;
  }
}

/**
 * Read the space without creating one. Use where absence is meaningful (an
 * admin view, a maintenance sweep that should skip users who never started).
 */
export async function getObsiddySpace(userId: string): Promise<ObsiddySpace | null> {
  if (!userId) return null;
  return prisma.obsiddySpace.findUnique({ where: { userId } });
}

/**
 * Resolve a space by its inbox token — the email-capture entry point.
 *
 * Returns null rather than throwing on an unknown token: the caller is an
 * inbound webhook handler, and an unrecognised address is a routine event
 * (bounce, stale forward), not an error condition.
 */
export async function findSpaceByInboxToken(inboxToken: string): Promise<ObsiddySpace | null> {
  if (!inboxToken) return null;
  return prisma.obsiddySpace.findUnique({ where: { inboxToken } });
}

/** Prisma's unique-constraint error code, without importing the runtime namespace. */
function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
