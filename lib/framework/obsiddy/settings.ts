/**
 * Space settings — defaults, and the safe read of three `Json` columns.
 *
 * `priorityWeights`, `energyProfile` and `retentionPolicy` are `Json?` in
 * Postgres, which means the database guarantees nothing about their shape. A
 * row can hold `{"urgency": "loads"}` after a bad migration, a hand-edit, or a
 * restore from an older backup — and the scorer would then multiply by a string
 * and write `NaN` into every `priorityScore` in the account.
 *
 * So **every read of these columns goes through a resolver here**, never
 * `space.priorityWeights as PriorityWeights`. The resolvers safe-parse and fall
 * back to the defaults rather than throwing: a malformed settings blob should
 * degrade to standard behaviour with a warning, not take a user's whole brain
 * offline. That is the opposite of the rule at the HTTP boundary, where a
 * malformed body is a 400 — the difference is that here there is no caller to
 * correct, and the data is already stored.
 *
 * Defaults live in code, not in the row (`services/space.ts` creates spaces with
 * these columns null). Adding a factor or a retention window then costs nothing;
 * defaults written into every row at creation would need a backfill.
 */

import {
  energyProfileSchema,
  PRIORITY_FACTORS,
  priorityWeightsSchema,
  retentionPolicySchema,
  type EnergyProfile,
  type PriorityWeights,
  type RetentionPolicy,
} from '@/lib/framework/obsiddy/validations';
import { logger } from '@/lib/logging';

/**
 * The plan's formula (§10), verbatim:
 *
 *   base = 0.30·urgency + 0.25·goalAlignment + 0.15·projectMomentum
 *        + 0.15·areaBalance + 0.10·effortFit + 0.05·staleness
 */
export const DEFAULT_PRIORITY_WEIGHTS: PriorityWeights = {
  urgency: 0.3,
  goalAlignment: 0.25,
  projectMomentum: 0.15,
  areaBalance: 0.15,
  effortFit: 0.1,
  staleness: 0.05,
};

export const DEFAULT_ENERGY_PROFILE: EnergyProfile = {
  morning: 'high',
  afternoon: 'medium',
  evening: 'low',
};

/** Windows from the §11 retention table. */
export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  inboxThoughtDays: 90,
  completedTaskDays: 180,
  closedProjectDays: 180,
  reviewDays: 730,
  staleEntityDays: 365,
  suggestedLinkDays: 60,
  eventDays: 400,
  planTimeBlockDays: 90,
};

/** Weekly minutes a user expects to have. 2400 = 40 hours, matching the column default. */
export const DEFAULT_WEEKLY_CAPACITY_MINUTES = 2400;

/**
 * Read the scorer weights, normalising so they always sum to 1.
 *
 * Normalisation is belt-and-braces on top of the Zod refinement at the HTTP
 * boundary. The refinement guards the one path a person can write through; this
 * guards the invariant itself. It matters because `base ∈ [0, 1]` is what makes
 * `manualBoost: +1` provably outrank every unboosted task (§10) — if weights
 * ever summed to 1.4 that guarantee would fail silently, months after the edit
 * that caused it, and present as "the pin doesn't work sometimes".
 */
export function resolvePriorityWeights(value: unknown): PriorityWeights {
  const parsed = priorityWeightsSchema.safeParse(value);

  if (!parsed.success) {
    // Null is the normal case — a space that has never customised its weights —
    // so it is not worth a log line. Anything else means stored data we can't read.
    if (value !== null && value !== undefined) {
      logger.warn('Obsiddy priorityWeights unreadable, using defaults', {
        issues: parsed.error.issues.length,
      });
    }
    return DEFAULT_PRIORITY_WEIGHTS;
  }

  return normaliseWeights(parsed.data);
}

/**
 * Scale weights to sum to exactly 1, preserving their ratios.
 *
 * Exported for the scorer's own test: the guarantee it protects is asserted
 * directly rather than only through the resolver.
 */
export function normaliseWeights(weights: PriorityWeights): PriorityWeights {
  const total = PRIORITY_FACTORS.reduce((sum, key) => sum + weights[key], 0);

  // All-zero weights would divide by zero and produce NaN scores. There is no
  // sensible ratio to preserve, so fall back rather than invent one.
  if (!Number.isFinite(total) || total <= 0) return DEFAULT_PRIORITY_WEIGHTS;
  if (Math.abs(total - 1) < 1e-9) return weights;

  return {
    urgency: weights.urgency / total,
    goalAlignment: weights.goalAlignment / total,
    projectMomentum: weights.projectMomentum / total,
    areaBalance: weights.areaBalance / total,
    effortFit: weights.effortFit / total,
    staleness: weights.staleness / total,
  };
}

// ─── Instance settings ───────────────────────────────────────────────────────

/**
 * What happens to an uploaded document's original bytes.
 *
 * **`discard` is the default, and that is a security decision rather than a
 * frugal one.** Retaining a user's uploaded PDF is only safe if the storage
 * provider can hold it privately *and* hand it back — and not every one can.
 * Discarding the bytes after parsing keeps the extracted text and the embedding
 * chunks, which is what the product actually uses, and leaves no blob to leak.
 *
 * `retain` is available for deployments whose provider declares
 * `capabilities.privateObjects` and `capabilities.signedUrls`. The admin page
 * names the resolved provider and says what it can do, so the choice is
 * informed.
 *
 * This was ask #15, filed when the interface had no read method at all and
 * `LocalProvider` silently ignored `public: false`. Sunrise closed it
 * (sunrise#490): the local provider gained a private root and a signed read
 * route, and capability became a declaration rather than something a caller
 * infers from a provider's name. The default stays `discard` — a capable
 * provider makes retention *possible*, not *advisable*, and keeping bytes you do
 * not need is still the thing that turns a bug into a breach.
 */
export const DOCUMENT_ORIGINAL_MODES = ['discard', 'retain'] as const;

export type DocumentOriginalsMode = (typeof DOCUMENT_ORIGINAL_MODES)[number];

export const DEFAULT_DOCUMENT_ORIGINALS: DocumentOriginalsMode = 'discard';

/**
 * Upload ceiling in bytes when the operator has not set one.
 *
 * 25 MB — deliberately between Sunrise's two contradictory caps (5 MB global in
 * `lib/validations/storage.ts`, 50 MB local to the bulk knowledge route, Sunrise
 * ask #9). 5 MB rejects an ordinary scanned PDF; 50 MB is more than a personal
 * brain needs and more than one request should parse synchronously. Operators who
 * disagree change it in the admin area rather than patching a constant.
 */
export const DEFAULT_MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

/**
 * Resolve the retention mode from the stored column.
 *
 * Falls back to `discard` on anything unrecognised. This one **must** fail safe
 * rather than fail open: a garbled value meaning "retain" would start publishing
 * files, whereas a garbled value meaning "discard" only loses an optional
 * convenience.
 */
export function resolveDocumentOriginals(value: unknown): DocumentOriginalsMode {
  if (typeof value === 'string') {
    const match = DOCUMENT_ORIGINAL_MODES.find((mode) => mode === value);
    if (match) return match;
    logger.warn('Obsiddy documentOriginals unreadable, discarding originals', { value });
  }
  return DEFAULT_DOCUMENT_ORIGINALS;
}

/** Resolve the upload ceiling, ignoring non-positive stored values. */
export function resolveMaxDocumentBytes(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return DEFAULT_MAX_DOCUMENT_BYTES;
}

export function resolveEnergyProfile(value: unknown): EnergyProfile {
  const parsed = energyProfileSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_ENERGY_PROFILE;
}

export function resolveRetentionPolicy(value: unknown): RetentionPolicy {
  const parsed = retentionPolicySchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_RETENTION_POLICY;
}
