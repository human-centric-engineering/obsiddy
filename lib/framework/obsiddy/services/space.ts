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

import {
  createSpace,
  findSpaceByToken,
  findSpaceByUserId,
  updateSpaceSettings,
} from '@/lib/framework/obsiddy/repo/space';
import {
  resolveEnergyProfile,
  resolvePriorityWeights,
  resolveRetentionPolicy,
} from '@/lib/framework/obsiddy/settings';
import type {
  EnergyProfile,
  PriorityWeights,
  RetentionPolicy,
  UpdateSpaceInput,
} from '@/lib/framework/obsiddy/validations';
import { STRENGTH_FLOOR } from '@/lib/framework/obsiddy/search/connections';
import { ensureObsiddySchedules } from '@/lib/framework/obsiddy/schedules/ensure';
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

  const existing = await findSpaceByUserId(userId);
  if (existing) return existing;

  try {
    const created = await createSpace({ userId, inboxToken: generateInboxToken() });

    // Defaults for timezone, weights and retention live in code, not in this
    // row — a new scorer factor or retention window must not need a backfill.
    logger.info('Obsiddy space created', { userId, spaceId: created.id });

    // A user's background workflows start the moment their brain exists.
    //
    // Fire-and-forget, and never allowed to fail the create. This runs on the
    // read path of a brand-new brain — a first page load must not 500 because
    // the workflow seeds have not been applied yet, or because the schedule
    // table is briefly unavailable. `ensureObsiddySchedules` is idempotent and
    // self-correcting, so the next visit picks up whatever this missed.
    await ensureObsiddySchedules(userId, created.timezone).catch((error: unknown) => {
      logger.warn('Obsiddy schedules could not be created for a new space', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    return created;
  } catch (error) {
    // Lost the race — the other request created it. Any other failure rethrows.
    if (isUniqueConstraintViolation(error)) {
      const raced = await findSpaceByUserId(userId);
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
  return findSpaceByUserId(userId);
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
  return findSpaceByToken(inboxToken);
}

/**
 * The settings payload `GET /obsiddy/space` returns.
 *
 * It carries the **effective** settings, not the raw columns: the three `Json`
 * columns are null until someone customises them, and a settings screen that
 * rendered nulls would show empty weight boxes and imply the scorer has no
 * opinion. Resolving here means the client sees what is actually in force, and
 * `customised` tells it which values are the user's own.
 *
 * `inboxToken` is deliberately **absent**. It is a bearer credential that routes
 * email into this brain (§17 risk 8), and a general settings read is exactly the
 * kind of response that ends up in a log, a cache or a bug report. It gets its
 * own endpoint when email capture lands in phase 9.
 */
export interface ObsiddySettings {
  timezone: string;
  weeklyCapacityMinutes: number;
  workStyle: string;
  priorityWeights: PriorityWeights;
  energyProfile: EnergyProfile;
  retentionPolicy: RetentionPolicy;
  /**
   * The similarity a pair must clear to be proposed as a connection.
   *
   * Resolved, like the weights above: the column is nullable and the default lives
   * in code (`STRENGTH_FLOOR`), so a caller always sees the number actually in
   * force rather than a `null` it has to interpret.
   */
  connectionStrengthFloor: number;
  /** Which of the three Json columns hold the user's own values rather than defaults. */
  customised: { priorityWeights: boolean; energyProfile: boolean; retentionPolicy: boolean };
}

/**
 * Read the caller's settings, creating the space on first use.
 *
 * This is the natural "first page load" hook the plan asks for — a settings or
 * dashboard read is usually a new user's first authenticated request, and doing
 * the bootstrap here means their first write already has the space its FK needs.
 */
export async function getObsiddySettings(userId: string): Promise<ObsiddySettings> {
  return toSettings(await ensureObsiddySpace(userId));
}

/**
 * Apply a settings patch.
 *
 * Passing `null` for one of the `Json` columns resets it to the defaults, which
 * is a genuinely useful action ("put the weights back how they were") and needs
 * no separate endpoint. Omitting a key leaves it untouched.
 */
export async function updateObsiddySettings(
  userId: string,
  input: UpdateSpaceInput
): Promise<ObsiddySettings> {
  await ensureObsiddySpace(userId);

  // Strip `undefined` so an omitted key stays untouched rather than being
  // nulled. The assertion is sound and confined: only keys whose value is
  // `undefined` are removed, and a key can only hold `undefined` if it was
  // optional in `UpdateSpaceInput`, so the result still satisfies the type —
  // something `Object.fromEntries` cannot express. This is not an assertion on
  // external data (CLAUDE.md): `input` has already been through Zod. Mirrors
  // `definedOnly` in `services/resources.ts`.
  const data = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  ) as UpdateSpaceInput;

  const updated = await updateSpaceSettings(userId, data);

  logger.info('Obsiddy settings updated', { userId, fields: Object.keys(data) });

  return toSettings(updated);
}

function toSettings(space: ObsiddySpace): ObsiddySettings {
  return {
    timezone: space.timezone,
    weeklyCapacityMinutes: space.weeklyCapacityMinutes,
    workStyle: space.workStyle,
    priorityWeights: resolvePriorityWeights(space.priorityWeights),
    energyProfile: resolveEnergyProfile(space.energyProfile),
    retentionPolicy: resolveRetentionPolicy(space.retentionPolicy),
    connectionStrengthFloor: space.connectionStrengthFloor ?? STRENGTH_FLOOR,
    customised: {
      priorityWeights: space.priorityWeights !== null,
      energyProfile: space.energyProfile !== null,
      retentionPolicy: space.retentionPolicy !== null,
    },
  };
}

/** Prisma's unique-constraint error code, without importing the runtime namespace. */
function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
