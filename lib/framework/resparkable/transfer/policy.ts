/**
 * Transfer policy for the brain.
 *
 * The read half of this already exists — `repo/subject-export.ts` answers "what
 * is this person owed?" for GDPR Art. 15. This answers the harder question:
 * what can be written back into a *different* account, and what happens to
 * everything that pointed at something by id.
 *
 * ## Data only, on purpose
 *
 * This file imports no database client and calls nothing. It is a declaration
 * that the generic engine in `lib/portability/**` reads. That keeps it inside
 * the tier's ESLint boundary (only `repo/**` may reach Prisma) without needing
 * an exemption, and it means the whole policy can be unit-tested as a value.
 *
 * ## What is special about this tier
 *
 * Every table hangs off `ResparkableSpace` through `userId`, which is
 * simultaneously the owner column and the foreign key to the space row. So the
 * space must be written first, and every other table's ownership is rewritten by
 * changing one column. That is why the brain is the easy half of a transfer —
 * and why the hard part is everything that refers to a row *without* a foreign
 * key behind it.
 *
 * @see lib/portability/policy.ts — what each field means
 * @see lib/framework/resparkable/repo/subject-export.ts — the Art. 15 half
 * @see .context/framework/resparkable/transfer.md
 */

import { randomBytes } from 'node:crypto';

import { SEARCHABLE_ENTITY_TYPES } from '@/lib/framework/resparkable/validations';
import type { TransferPolicySet } from '@/lib/portability/policy';

/**
 * Maps a stored `entityType` / `sourceType` value onto its Prisma model.
 *
 * Derived from {@link SEARCHABLE_ENTITY_TYPES} rather than written out, so that
 * making a new kind of thing linkable updates the remapping automatically. The
 * `Resparkable` + capitalised-name convention is checked against the real model
 * graph by the coverage guard, which fails if a type is added that does not
 * follow it — the one way this derivation could go quietly wrong.
 */
const BRAIN_TYPE_MAP: Readonly<Record<string, string>> = Object.fromEntries(
  SEARCHABLE_ENTITY_TYPES.map((type) => [
    type,
    `Resparkable${type.charAt(0).toUpperCase()}${type.slice(1)}`,
  ])
);

/** What a thought can be promoted into. */
const PROMOTION_TYPE_MAP: Readonly<Record<string, string>> = {
  task: 'ResparkableTask',
  project: 'ResparkableProject',
  goal: 'ResparkableGoal',
};

/** Collapse whitespace and case so two spellings of one title compare equal. */
function normaliseTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Stringify a value read out of an untyped row.
 *
 * A soft merge key is computed over `Record<string, unknown>` — the row may have
 * come from a bundle rather than from Prisma — so a bare `String()` would
 * happily render an object as `[object Object]` and make two unrelated rows
 * compare equal. Anything that is not already a primitive contributes nothing.
 */
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** `YYYY-MM-DD`, or empty — dates arrive as strings from a bundle, as Dates from the DB. */
function dayOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string' && value.length >= 10) return value.slice(0, 10);
  return '';
}

const BRAIN = { owner: 'framework:resparkable', group: 'brain' } as const;

/**
 * `indexedHash` appears on seven tables and means the same thing on all of them.
 *
 * Written once and spread, rather than restated seven times: an exemption from
 * the secret guard is only worth anything if somebody reads it, and seven
 * copies of the same sentence is how a reader learns to skip them.
 */
const INDEXED_HASH_REVIEWED = {
  indexedHash:
    'A digest of this row’s own text, used to notice when it has changed and ' +
    'needs re-embedding. Derived from content that is itself in the bundle, so ' +
    'it discloses nothing further — and it is reset on import in any case.',
} as const;

export const resparkableTransferPolicies: TransferPolicySet = {
  policies: [
    {
      ...BRAIN,
      model: 'ResparkableSpace',
      disposition: 'transfer',
      note: 'The brain itself — your timezone, weekly capacity and how work gets prioritised.',
      ownerColumn: 'userId',
      mergeKeys: [['userId']],
      // A live bearer token: anyone holding it can post into this person's
      // inbox, on the installation this bundle was taken FROM. So it is dropped
      // rather than merely not-written — `repo/subject-export.ts` omits it from
      // the Art. 15 export for exactly this reason, and a transfer bundle is
      // more of "a file that gets emailed, synced and forgotten", not less.
      // Being absent also makes the import unambiguous: the column is unique,
      // so the target has to mint its own regardless.
      redact: ['inboxToken'],
      // Required, unique, and never in a bundle — so an import has to issue one
      // or it cannot write this table at all. Sized and encoded exactly as
      // `services/space.ts` does when it mints one for a new user: 16 bytes of
      // hex, because the value lands in an email local part and has to survive
      // mail systems that lowercase it.
      mint: { inboxToken: () => randomBytes(16).toString('hex') },
      reset: {
        // Where the weekly connection sweep got to. Points at this
        // installation's clock, not at anything the user owns.
        lastSweptAt: null,
        // A similarity threshold tuned against whichever embedding model
        // produced this brain's vectors. Carried into an environment running a
        // different model it does not error — it silently stops proposing
        // connections, or proposes nonsense. Re-learned from scratch instead.
        connectionStrengthFloor: null,
      },
      jsonOpaque: {
        energyProfile: 'Time-of-day energy buckets. Numbers and weekday names.',
        priorityWeights: 'Scoring weights. Numbers.',
        retentionPolicy: 'How long to keep things, in days. Numbers.',
      },
    },

    {
      ...BRAIN,
      model: 'ResparkableArea',
      disposition: 'transfer',
      note: 'The life areas you organise everything else under.',
      ownerColumn: 'userId',
      mergeKeys: [['userId', 'slug']],
      reset: { indexedHash: null },
      secretReviewed: { ...INDEXED_HASH_REVIEWED },
    },

    {
      ...BRAIN,
      model: 'ResparkableGoal',
      disposition: 'transfer',
      note: 'Goals across every horizon, including which goal sits under which.',
      ownerColumn: 'userId',
      // A real constraint, as for areas, projects and entities. This table used
      // to carry a soft key instead — horizon, normalised title, target date —
      // because it had no `@@unique` to point at, and that guess was the one
      // thing blocking `conflictMode: 'overwrite'`: writing into a row matched
      // on a guess is writing into a guess. The soft key is gone rather than
      // kept as a fallback, so there is exactly one answer to "is this the same
      // goal?" and it is the same answer the vault importer gives.
      mergeKeys: [['userId', 'slug']],
      reset: { indexedHash: null },
      secretReviewed: { ...INDEXED_HASH_REVIEWED },
    },

    {
      ...BRAIN,
      model: 'ResparkableProject',
      disposition: 'transfer',
      note: 'Projects, their status, and which area they belong to.',
      ownerColumn: 'userId',
      mergeKeys: [['userId', 'slug']],
      reset: {
        indexedHash: null,
        // Recomputed by the prioritiser on the far side. The stored score is
        // relative to the weights and the population it was computed against,
        // so importing it would rank new work against an old brain's scale.
        priorityScore: 0,
        priorityFactors: null,
      },
      jsonOpaque: {
        priorityFactors:
          'The breakdown behind the score — named factors and their numeric ' +
          'contributions. Reset on import rather than carried, so nothing here ' +
          'survives to need remapping.',
      },
      secretReviewed: { ...INDEXED_HASH_REVIEWED },
    },

    {
      ...BRAIN,
      model: 'ResparkableTask',
      disposition: 'transfer',
      note: 'Tasks with their notes, scheduling, snooze history and manual priority boosts.',
      ownerColumn: 'userId',
      reset: { priorityScore: 0, priorityFactors: null },
      // Deliberately no merge key. Two tasks with the same title are usually two
      // tasks. A duplicate task is a minor annoyance; a wrongly merged one loses
      // notes, scheduling and history that cannot be recovered.
      jsonOpaque: {
        priorityFactors: 'Scoring breakdown. Reset on import, as for projects.',
      },
      secretReviewed: {
        // `manualBoost` is not a secret, but it is the one column an agent is
        // forbidden from writing — it is the user's own override of the
        // prioritiser. It transfers verbatim: it is precisely the thing someone
        // would be angriest to lose, and an expired boost reads as zero anyway.
        manualBoost: 'A user-set priority override, not credential material.',
      },
    },

    {
      ...BRAIN,
      model: 'ResparkableThought',
      disposition: 'transfer',
      note: 'Raw captured thoughts — the most personal free text in the product.',
      ownerColumn: 'userId',
      reset: { indexedHash: null },
      softRefs: [
        {
          idColumn: 'promotedToId',
          typeColumn: 'promotedToType',
          typeMap: PROMOTION_TYPE_MAP,
          // Nullable, and a thought whose promotion target did not come across
          // is still a thought worth keeping.
          onUnresolved: 'null',
        },
      ],
      softRefsIgnored: {
        externalId:
          'The originating system’s id for a captured message — an email ' +
          'Message-ID, a shortcut run id. Used to avoid capturing the same ' +
          'thing twice, and meaningless as a reference to any row here.',
      },
      // `[userId, externalId]` is a real constraint but `externalId` is null for
      // anything captured in the app, and Postgres treats nulls as distinct — so
      // it binds for exactly the inbound-integration rows and no others. That is
      // still worth having: re-importing must not duplicate emailed captures.
      mergeKeys: [['userId', 'externalId']],
      softMergeKey: (row: Readonly<Record<string, unknown>>): string | null => {
        const content = typeof row.content === 'string' ? row.content.trim() : '';
        if (content === '') return null;
        return `${content}|${dayOf(row.createdAt)}`;
      },
      secretReviewed: { ...INDEXED_HASH_REVIEWED },
    },

    {
      ...BRAIN,
      model: 'ResparkableEntity',
      disposition: 'transfer',
      note: 'Notes about other people and companies — your own record of who is who.',
      ownerColumn: 'userId',
      mergeKeys: [['userId', 'slug']],
      reset: { indexedHash: null },
      secretReviewed: { ...INDEXED_HASH_REVIEWED },
    },

    {
      ...BRAIN,
      model: 'ResparkableTag',
      disposition: 'transfer',
      note: 'Your own tag vocabulary, with the colours and order you gave it.',
      ownerColumn: 'userId',
      mergeKeys: [['userId', 'slug']],
    },

    {
      ...BRAIN,
      model: 'ResparkableTaskTag',
      disposition: 'transfer',
      note: 'Which tags are on which tasks.',
      ownerColumn: 'userId',
      // Both columns are foreign keys, so this can only be evaluated after the
      // tasks and tags they name have been remapped.
      mergeKeys: [['taskId', 'tagId']],
    },

    {
      ...BRAIN,
      model: 'ResparkableChecklistItem',
      disposition: 'transfer',
      note: 'Checklist steps inside tasks.',
      ownerColumn: 'userId',
      // No constraint exists, and position plus text is a reasonable identity
      // for a step within an already-matched task.
      softMergeKey: (row: Readonly<Record<string, unknown>>): string | null => {
        const step = typeof row.text === 'string' ? normaliseTitle(row.text) : '';
        if (step === '') return null;
        return `${text(row.taskId)}|${text(row.position)}|${step}`;
      },
    },

    {
      ...BRAIN,
      model: 'ResparkableBoard',
      disposition: 'transfer',
      note: 'Kanban boards, their columns and their filters.',
      ownerColumn: 'userId',
      mergeKeys: [['userId', 'slug']],
      jsonRefs: [
        // A board with `membership: 'filter'` is a live query, not a fixed list.
        // If this id does not resolve, the board renders empty with no error —
        // so the dry run names every affected board rather than counting them.
        {
          column: 'filter',
          path: 'projectId',
          model: 'ResparkableProject',
          onUnresolved: 'null',
        },
      ],
      jsonOpaque: {
        columns:
          'Column definitions — name, the status each maps to, and a colour. ' +
          'Statuses are enum values, not row ids.',
      },
    },

    {
      ...BRAIN,
      model: 'ResparkableBoardCard',
      disposition: 'transfer',
      note: 'Where each task sits on a board — the arrangement, not just the tasks.',
      ownerColumn: 'userId',
      mergeKeys: [['boardId', 'taskId']],
    },

    {
      ...BRAIN,
      model: 'ResparkableTimeBlock',
      disposition: 'transfer',
      note: 'What you planned or recorded working on, and when.',
      ownerColumn: 'userId',
      softMergeKey: (row: Readonly<Record<string, unknown>>): string | null => {
        const start = row.startAt instanceof Date ? row.startAt.toISOString() : text(row.startAt);
        return `${start}|${text(row.title)}`;
      },
    },

    {
      ...BRAIN,
      model: 'ResparkableLink',
      disposition: 'transfer',
      note:
        'Connections between items, including ones you rejected. Rejected links ' +
        'are kept deliberately: they are what stops the weekly sweep proposing ' +
        'the same connection again for ever.',
      ownerColumn: 'userId',
      softRefs: [
        {
          idColumn: 'sourceId',
          typeColumn: 'sourceType',
          typeMap: BRAIN_TYPE_MAP,
          // Both ends are required columns, so there is nothing to null. A link
          // to something that did not come across is not a link.
          onUnresolved: 'drop-row',
        },
        {
          idColumn: 'targetId',
          typeColumn: 'targetType',
          typeMap: BRAIN_TYPE_MAP,
          onUnresolved: 'drop-row',
        },
      ],
      // Contains four remapped values, so it can only be evaluated after both
      // ends have been resolved.
      mergeKeys: [['userId', 'sourceType', 'sourceId', 'targetType', 'targetId', 'kind']],
    },

    {
      ...BRAIN,
      model: 'ResparkableDocument',
      disposition: 'transfer',
      note: 'Documents you uploaded, and the text extracted from them.',
      ownerColumn: 'userId',
      // Content-addressed, which makes this the one table where identity is
      // exact: the same file is the same row, in any account.
      mergeKeys: [['userId', 'fileHash']],
      reset: {
        indexedHash: null,
        // Rewritten by the importer when the original bytes travel with the
        // bundle, and left null when they do not — in which case the extracted
        // text, which is what the product actually uses, still arrives.
        storageKey: null,
      },
      secretReviewed: {
        ...INDEXED_HASH_REVIEWED,
        fileHash:
          'A SHA-256 digest of the file contents, used for de-duplication and ' +
          'as this table’s merge key. Not credential material.',
        storageKey:
          'The blob-store path of the uploaded original, of the form ' +
          '`framework-resparkable/<userId>/<fileHash>`. A location, not a ' +
          'credential — and rewritten on import, or nulled when the originals ' +
          'do not travel.',
      },
    },

    {
      ...BRAIN,
      model: 'ResparkableReview',
      disposition: 'transfer',
      note: 'Your generated weekly and monthly reviews, with their full text.',
      ownerColumn: 'userId',
      reset: { indexedHash: null },
      softRefs: [
        {
          idColumn: 'workflowExecutionId',
          model: 'AiWorkflowExecution',
          // Crosses into the orchestration tables, which are export-only — so
          // this will not resolve even when the whole account moves. The review
          // itself is the artefact worth keeping; the run that produced it is a
          // footnote.
          onUnresolved: 'null',
        },
      ],
      jsonRefs: [
        {
          column: 'payload',
          // A whole-value scan rather than a path, and deliberately so: this
          // column is typed `unknown` because each horizon renders a different
          // shape, and it is writable by an agent. Any path declared here would
          // be correct until the next renderer gained a field, then silently
          // stop matching. See the `'**'` note on JsonRef.
          path: '**',
          onUnresolved: 'keep',
        },
      ],
      softMergeKey: (row: Readonly<Record<string, unknown>>): string | null =>
        `${text(row.horizon)}|${dayOf(row.generatedAt)}`,
      secretReviewed: { ...INDEXED_HASH_REVIEWED },
    },

    {
      ...BRAIN,
      model: 'ResparkableEvent',
      disposition: 'export-only',
      note:
        'Your activity log — what you did in the product and when. Included so ' +
        'the record is yours, but not written back: a timeline recreated in a ' +
        'new environment would describe activity that never happened there, ' +
        'sitting beside real entries and indistinguishable from them.',
      ownerColumn: 'userId',
      softRefsIgnored: {
        entityId:
          'Identifies whichever row an entry describes, across every table in ' +
          'the tier. Kept verbatim because the log is never replayed — it is ' +
          'read against the environment that wrote it.',
      },
      jsonOpaque: {
        metadata:
          'What changed, as short strings and counts. Deliberately never an ' +
          'email address (see the schema comment on this table).',
      },
    },
  ],

  excluded: [
    {
      model: 'ResparkableEmbedding',
      owner: 'framework:resparkable',
      reason:
        'Search vectors and the text chunks they were built from, derived from ' +
        'thoughts, tasks, notes, documents and reviews that all transfer in ' +
        'full. They carry nothing those rows do not, the vector columns cannot ' +
        'be read or written through Prisma, and a vector produced by one ' +
        'embedding model is meaningless to another — so they are rebuilt on the ' +
        'far side rather than moved.',
    },
    {
      model: 'ResparkableSettings',
      owner: 'framework:resparkable',
      reason:
        'A single operator-owned row keyed by slug, holding whether this ' +
        'installation retains uploaded document originals and how large an ' +
        'upload may be. It describes the installation rather than any person — ' +
        'there is no user id on it — so importing it would overwrite another ' +
        'operator’s policy with this one’s.',
    },
  ],

  crossBoundaryEdges: [
    {
      model: 'ResparkableReview',
      column: 'workflowExecutionId',
      reason:
        'Points into the orchestration tables, where executions are export-only ' +
        'because an inbound run stores its raw trigger payload verbatim. The ' +
        'reference is nulled on import and the review is kept.',
    },
  ],
};
