/**
 * The morning briefing — reading the stored one, and selecting what goes into
 * the next.
 *
 * ## Two functions, two very different costs
 *
 * `getStoredBriefing` is what the button calls. It reads one row and returns it,
 * because `plan.md` §6 is emphatic that nobody should wait twenty seconds after
 * pressing a button for something whose inputs barely changed between 3am and
 * 8am. The nightly workflow writes the briefing; the button serves it.
 *
 * `buildBriefingInputs` is what the *workflow* calls, and it is the piece that
 * replaces a step the plan originally specified. §6 had a **`route`** step
 * branching three ways on `workStyle` — but `route` is an LLM classifier, so
 * that would spend a model call asking a language model to guess a `VarChar(16)`
 * we can simply select, and let it guess wrong. The selection happens here, in
 * code, and the workflow makes exactly one LLM call: the one that writes prose.
 *
 * ## `workStyle` changes the data, not the adjectives
 *
 * This is the rule §6 sets and the reason the whole setting is not theatre: a
 * version that only varied the tone would be the same briefing with different
 * adjectives, and people notice within a week. So each style selects genuinely
 * different rows — and the styles are ordered by *what leads*, not by how much
 * they say.
 *
 * ## What is deliberately not here
 *
 * §6's exploratory branch also lists "one `resparkable_ideate` angle on an active
 * project". Ideation is an LLM call, and putting one inside the step whose whole
 * purpose is to be free would quietly double the briefing's daily cost. The
 * briefing's own single `llm_call` is already a model looking at the user's
 * material and is perfectly placed to do the framing — so the prompt asks for
 * it, rather than a second model call precomputing it.
 */

import { listUnreviewedLinks } from '@/lib/framework/resparkable/repo/links';
import type { OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { findLatestReview } from '@/lib/framework/resparkable/repo/reviews';
import { listThoughts } from '@/lib/framework/resparkable/repo/thoughts';
import {
  buildBriefingFacts,
  type BriefingFacts,
} from '@/lib/framework/resparkable/services/briefing-facts';
import { hydrateLinks } from '@/lib/framework/resparkable/services/link-hydration';
import { getResparkableSettings } from '@/lib/framework/resparkable/services/space';
import { WORK_STYLES } from '@/lib/framework/resparkable/validations';
import type { ResparkableReview } from '@prisma/client';

/** The `ResparkableReview.horizon` value the briefing is stored under. */
export const BRIEFING_HORIZON = 'briefing';

/**
 * How old a stored briefing may be before it is called stale.
 *
 * Eighteen hours, from §6: long enough that a briefing written at 3am is still
 * fresh at 8pm the same day, short enough that a *missed* nightly run is
 * detected the next morning rather than serving yesterday's plan as today's.
 */
export const BRIEFING_STALE_HOURS = 18;

/** How far back a thought must be to count as worth resurfacing (§6). */
const RESURFACE_MIN_AGE_DAYS = 90;

/** Per-style caps. Small on purpose — a briefing nobody finishes reading is not one. */
const STRUCTURED_TASKS = 5;
const BALANCED_TASKS = 3;
const EXPLORATORY_LINKS = 3;

export type ResparkableWorkStyle = (typeof WORK_STYLES)[number];

export interface StoredBriefing {
  review: ResparkableReview | null;
  /** True when there is none, or the newest is older than {@link BRIEFING_STALE_HOURS}. */
  stale: boolean;
  /** Whole hours since it was generated; `null` when there is none. */
  ageHours: number | null;
}

/** A connection worth leading with — hydrated, because ids are not readable. */
export interface BriefingConnection {
  id: string;
  /** Nullable in the schema — a hand-created link has no similarity score. */
  strength: number | null;
  rationale: string | null;
  sourceTitle: string | null;
  targetTitle: string | null;
}

export interface BriefingInputs {
  /** The style actually used, after any per-run override. */
  workStyle: ResparkableWorkStyle;
  /** True when an override was applied — the UI says so rather than implying the setting changed. */
  overridden: boolean;
  /** Which prompt the `llm_call` should use. */
  promptKey: `briefing_${ResparkableWorkStyle}`;
  /** The deterministic half, already rendered. */
  facts: BriefingFacts;
  /** What this style leads with. Populated per style; empty arrays elsewhere. */
  selection: {
    tasks: BriefingFacts['snapshot']['topTasks']['items'];
    connections: BriefingConnection[];
    resurfaced: { id: string; content: string; capturedAt: Date } | null;
  };
}

function isWorkStyle(value: string): value is ResparkableWorkStyle {
  return (WORK_STYLES as readonly string[]).includes(value);
}

/**
 * Coerce a stored or supplied style to a known one.
 *
 * The column is a `VarChar(16)`, not a database enum, so an unrecognised value
 * is reachable — an older row, a hand-edited record, a future style rolled back.
 * Falling back to `balanced` means a briefing still gets written; throwing would
 * mean the nightly run fails for that user and nobody finds out until they
 * notice the silence.
 */
function resolveWorkStyle(value: string | undefined): ResparkableWorkStyle {
  return value && isWorkStyle(value) ? value : 'balanced';
}

/**
 * The stored briefing and whether it can be trusted as today's.
 *
 * Reads, and never writes or generates. That separation is what lets the button
 * be instant and the API decide — from `stale` — whether to offer regeneration.
 */
export async function getStoredBriefing(
  scope: OwnerScope,
  now: Date = new Date()
): Promise<StoredBriefing> {
  const review = await findLatestReview(scope, BRIEFING_HORIZON);
  if (!review) return { review: null, stale: true, ageHours: null };

  const ageMs = now.getTime() - review.generatedAt.getTime();
  const ageHours = Math.floor(ageMs / (60 * 60 * 1000));

  return { review, stale: ageHours >= BRIEFING_STALE_HOURS, ageHours };
}

/**
 * Everything the briefing's one LLM call needs, selected by work style.
 *
 * `workStyleOverride` is the "surprise me today" control (§6): it changes this
 * run without touching the stored setting, because people are structured in a
 * deadline week and exploratory on a quiet Friday, and a setting that could not
 * be overridden would become a cage.
 */
export async function buildBriefingInputs(
  scope: OwnerScope,
  options: { workStyleOverride?: string } = {},
  now: Date = new Date()
): Promise<BriefingInputs> {
  const settings = await getResparkableSettings(scope.userId);

  const stored = resolveWorkStyle(settings.workStyle);
  const requested = options.workStyleOverride
    ? resolveWorkStyle(options.workStyleOverride)
    : stored;
  const overridden = requested !== stored;

  const facts = await buildBriefingFacts(scope, now);

  const selection: BriefingInputs['selection'] = {
    tasks: [],
    connections: [],
    resurfaced: null,
  };

  if (requested === 'structured') {
    selection.tasks = facts.snapshot.topTasks.items.slice(0, STRUCTURED_TASKS);
  } else if (requested === 'balanced') {
    selection.tasks = facts.snapshot.topTasks.items.slice(0, BALANCED_TASKS);
    selection.connections = await topConnections(scope, 1, now);
  } else {
    selection.connections = await topConnections(scope, EXPLORATORY_LINKS, now);
    selection.resurfaced = await resurfacedThought(scope, now);
  }

  return {
    workStyle: requested,
    overridden,
    promptKey: `briefing_${requested}`,
    facts,
    selection,
  };
}

/**
 * The strongest unreviewed connections, with both ends named.
 *
 * Hydrated rather than returned raw: an `ResparkableLink` is four opaque strings
 * (D2), and "project_a1b2 relates to thought_c3d4" is not something a model can
 * write a sentence about.
 */
async function topConnections(
  scope: OwnerScope,
  limit: number,
  now: Date
): Promise<BriefingConnection[]> {
  const links = await listUnreviewedLinks(scope, limit, now);
  if (links.length === 0) return [];

  const hydrated = await hydrateLinks(scope, links);

  return hydrated.map(({ link, source, target }) => ({
    id: link.id,
    strength: link.strength,
    rationale: link.rationale,
    sourceTitle: source.title,
    targetTitle: target.title,
  }));
}

/**
 * One old, still-untriaged thought.
 *
 * Takes the **newest** thought that is nonetheless older than the cutoff, which
 * is `listThoughts`' own ordering and is the right choice rather than a
 * concession to it. Oldest-first would return the same ancient note every single
 * morning until it was triaged — a daily nag rather than a resurfacing. Taking
 * the newest of the eligible makes the window roll: each day surfaces something
 * that has just crossed ninety days, and the briefing keeps finding new material
 * without anyone tending it.
 */
async function resurfacedThought(
  scope: OwnerScope,
  now: Date
): Promise<BriefingInputs['selection']['resurfaced']> {
  const cutoff = new Date(now.getTime() - RESURFACE_MIN_AGE_DAYS * 24 * 60 * 60 * 1000);

  const [thought] = await listThoughts(
    scope,
    { status: 'inbox', hideSnoozed: true, capturedBefore: cutoff },
    { take: 1 }
  );

  if (!thought) return null;
  return { id: thought.id, content: thought.content, capturedAt: thought.createdAt };
}
