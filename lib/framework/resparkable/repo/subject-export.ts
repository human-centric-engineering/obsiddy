/**
 * Subject-access export (GDPR Art. 15) for the brain.
 *
 * The counterpart to `repo/schedules.ts`'s erasure half. Resparkable already had
 * Art. 17 covered — every `framework_resparkable_*` table cascades from
 * `ResparkableSpace`, whose FK to `"user"` is `ON DELETE CASCADE` — but until
 * Resparkable 0.8.0 there was no seam through which a fork could answer Art. 15 at
 * all. resparkable#467 added one (`lib/app/data-export.ts`), and this is what fills
 * it.
 *
 * **This tier is the case the seam was written for.** A brain is not an app with
 * some personal data in it; it is nothing *but* personal data — captured
 * thoughts, notes on named people, uploaded documents and their extracted text,
 * a record of what its owner worked on and when. An export that omitted it would
 * be a bundle that looks complete and answers almost nothing.
 *
 * ## Two dispositions, matching core's
 *
 * Core's manifest (`lib/privacy/export-sources.ts`) splits sources into
 * `export` and `attribution`; Resparkable has no attribution case, because nothing
 * here is org config a user merely authored — every row *is* theirs. So the
 * split here is **exported** vs **excluded-with-a-reason**, and the reasons are
 * surfaced to the reader rather than left implicit.
 *
 * ## Omission is a deliberate list, not a select
 *
 * Every fetch uses Prisma's `omit` rather than `select`, deliberately copying
 * core's rule: a column added to one of these tables tomorrow is exported by
 * default, and only an explicit `omit` keeps it out. An allowlist `select` would
 * silently narrow the export every time the schema grew — the same quiet-omission
 * failure the coverage guard exists to prevent.
 *
 * ## The guard that keeps it complete
 *
 * `tests/unit/lib/framework/resparkable/privacy/subject-export.test.ts` reads
 * `prisma/schema/framework-resparkable.prisma` and fails if a model carrying a
 * `userId` is in neither {@link RESPARKABLE_SUBJECT_SOURCES} nor
 * {@link RESPARKABLE_EXCLUDED_MODELS}. Core cannot write that guard for a fork —
 * `lib/app/data-export.ts` says so explicitly and recommends exactly this
 * pattern. Adding a table without extending this file fails the build rather
 * than shipping a short answer to a data subject.
 *
 * @see lib/app/data-export.ts — the seam this fills
 * @see lib/framework/resparkable/erasure.ts — the Art. 17 half
 * @see .context/privacy/data-export.md — core's guide
 */

import { prisma } from '@/lib/db/client';
import { ownerWhere, type OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';

/** Oldest first, so a bundle reads as a history rather than a bag of rows. */
const CHRONOLOGICAL = { createdAt: 'asc' } as const;

/**
 * One exported table: the bundle section it lands under, and how it is read.
 *
 * Keyed by Prisma model name because that is what the completeness guard reads
 * out of the schema file — keying by section name would let a model be dropped
 * while its section lived on under another table's data.
 */
interface ResparkableSubjectSource {
  /** Key under `app.resparkable` in the export bundle. */
  section: string;
  /** Why this table holds the subject's data — shown to a reader of this file. */
  holds: string;
  fetch: (scope: OwnerScope) => Promise<unknown[]>;
}

/**
 * Every Resparkable table holding data about a person, and how it is exported.
 *
 * **`ResparkableSettings` is absent on purpose and is not an omission.** It is an
 * operator singleton keyed by `slug` with no `userId` at all (document-original
 * retention and the upload cap), so it holds nothing about any subject. The
 * completeness guard scans for `userId` and therefore never asks about it.
 */
export const RESPARKABLE_SUBJECT_SOURCES: Record<string, ResparkableSubjectSource> = {
  ResparkableSpace: {
    section: 'space',
    holds: 'The brain itself: timezone, capacity, energy profile and retention settings.',
    fetch: (scope) =>
      prisma.resparkableSpace.findMany({
        where: ownerWhere(scope),
        // `inboxToken` is a live bearer secret — anyone holding it can write
        // into this person's inbox. Core omits credential material from an
        // export even though the subject owns it, because the bundle is a file
        // that gets emailed, synced and forgotten; this follows that rule.
        omit: { inboxToken: true },
        orderBy: CHRONOLOGICAL,
      }),
  },
  ResparkableArea: {
    section: 'areas',
    holds: 'The life areas they organise their work under.',
    fetch: (scope) =>
      prisma.resparkableArea.findMany({ where: ownerWhere(scope), orderBy: CHRONOLOGICAL }),
  },
  ResparkableGoal: {
    section: 'goals',
    holds: 'Goals and their horizons, including the parent/child structure.',
    fetch: (scope) =>
      prisma.resparkableGoal.findMany({ where: ownerWhere(scope), orderBy: CHRONOLOGICAL }),
  },
  ResparkableProject: {
    section: 'projects',
    holds: 'Projects, their status and the priority the system computed for them.',
    fetch: (scope) =>
      prisma.resparkableProject.findMany({ where: ownerWhere(scope), orderBy: CHRONOLOGICAL }),
  },
  ResparkableTask: {
    section: 'tasks',
    holds: 'Tasks with their notes, scheduling, snooze history and priority factors.',
    fetch: (scope) =>
      prisma.resparkableTask.findMany({ where: ownerWhere(scope), orderBy: CHRONOLOGICAL }),
  },
  ResparkableThought: {
    section: 'thoughts',
    holds: 'Raw captured thoughts — the most personal free text in the product.',
    fetch: (scope) =>
      prisma.resparkableThought.findMany({ where: ownerWhere(scope), orderBy: CHRONOLOGICAL }),
  },
  ResparkableLink: {
    section: 'links',
    holds:
      'Connections between items, including the rationale the model wrote for a suggested one.',
    fetch: (scope) =>
      prisma.resparkableLink.findMany({ where: ownerWhere(scope), orderBy: CHRONOLOGICAL }),
  },
  ResparkableBoard: {
    section: 'boards',
    holds: 'Kanban boards, their columns and filters.',
    fetch: (scope) =>
      prisma.resparkableBoard.findMany({ where: ownerWhere(scope), orderBy: CHRONOLOGICAL }),
  },
  ResparkableBoardCard: {
    section: 'boardCards',
    holds: 'Where each task sits on a board — the arrangement, not just the tasks.',
    fetch: (scope) =>
      prisma.resparkableBoardCard.findMany({ where: ownerWhere(scope), orderBy: CHRONOLOGICAL }),
  },
  ResparkableTag: {
    section: 'tags',
    holds: 'Their own tag vocabulary.',
    fetch: (scope) =>
      prisma.resparkableTag.findMany({ where: ownerWhere(scope), orderBy: CHRONOLOGICAL }),
  },
  ResparkableTaskTag: {
    section: 'taskTags',
    holds: 'Which tags they put on which tasks.',
    fetch: (scope) =>
      prisma.resparkableTaskTag.findMany({ where: ownerWhere(scope), orderBy: CHRONOLOGICAL }),
  },
  ResparkableChecklistItem: {
    section: 'checklistItems',
    holds: 'Checklist steps inside tasks, with their own free text.',
    fetch: (scope) =>
      prisma.resparkableChecklistItem.findMany({
        where: ownerWhere(scope),
        orderBy: CHRONOLOGICAL,
      }),
  },
  ResparkableEntity: {
    section: 'people',
    holds:
      'Notes about OTHER people and companies. Third-party personal data the subject recorded — included because it is their record, and it is the section a reader is most likely to be surprised by.',
    fetch: (scope) =>
      prisma.resparkableEntity.findMany({ where: ownerWhere(scope), orderBy: CHRONOLOGICAL }),
  },
  ResparkableDocument: {
    section: 'documents',
    holds: 'Uploaded documents and the full text extracted from them.',
    fetch: (scope) =>
      prisma.resparkableDocument.findMany({ where: ownerWhere(scope), orderBy: CHRONOLOGICAL }),
  },
  ResparkableTimeBlock: {
    section: 'timeBlocks',
    holds: 'What they planned or recorded working on, and when.',
    fetch: (scope) =>
      prisma.resparkableTimeBlock.findMany({ where: ownerWhere(scope), orderBy: CHRONOLOGICAL }),
  },
  ResparkableReview: {
    section: 'reviews',
    holds: 'Generated weekly and monthly reviews, including their full body text.',
    fetch: (scope) =>
      prisma.resparkableReview.findMany({ where: ownerWhere(scope), orderBy: CHRONOLOGICAL }),
  },
  ResparkableEvent: {
    section: 'activity',
    holds:
      'The activity log — what they did in the product and when. Behavioural data, and squarely within Art. 15.',
    fetch: (scope) =>
      prisma.resparkableEvent.findMany({ where: ownerWhere(scope), orderBy: CHRONOLOGICAL }),
  },
};

/** A table left out of the export, and the reason a reader is owed. */
export interface ResparkableExcludedModel {
  model: string;
  reason: string;
}

/**
 * Tables deliberately left out, and why.
 *
 * Kept to the case core itself excludes — derived vectors — so that "excluded"
 * never quietly becomes the easy answer for a table someone did not want to
 * think about.
 */
export const RESPARKABLE_EXCLUDED_MODELS: ResparkableExcludedModel[] = [
  {
    model: 'ResparkableEmbedding',
    reason:
      'Numeric vectors and the text chunks they were built from, derived from thoughts, tasks, notes, documents and reviews that are already exported in full above. They carry no information those sections do not, and the vector columns are `Unsupported` in Prisma so they cannot be serialised anyway. Core excludes `AiMessageEmbedding` on identical grounds.',
  },
];

/** Every section name in the bundle, for the completeness guard and the docs. */
export const RESPARKABLE_EXPORT_SECTIONS = Object.values(RESPARKABLE_SUBJECT_SOURCES).map(
  (source) => source.section
);

/**
 * Collect one subject's entire brain.
 *
 * Runs the reads in parallel — they are independent single-table queries against
 * an already-indexed `userId`, and a brain with years of history has enough
 * tables that doing them in series is a noticeably slow request for something a
 * person is waiting on.
 *
 * Returns a plain section map. The caller (`lib/app/data-export.ts`) nests it
 * under one `resparkable` key rather than spreading it, so a host project's own app
 * tables cannot collide with a section name here.
 */
export async function collectResparkableSubjectData(
  scope: OwnerScope
): Promise<Record<string, unknown>> {
  const entries = Object.values(RESPARKABLE_SUBJECT_SOURCES);

  const rows = await Promise.all(entries.map((source) => source.fetch(scope)));

  return Object.fromEntries(entries.map((source, i) => [source.section, rows[i]]));
}
