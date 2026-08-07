# Account transfer

Moving one person's data out of an account and into a different one — a new
account, or the same account on a self-hosted install.

**Status: Phase A shipped.** The model graph, the policy manifest and the
coverage guards are in place. There is no export or import route yet; see
[Phases](#phases).

## What already existed, and why none of it was enough

| System                       | Reads                    | Writes back | Scope                       |
| ---------------------------- | ------------------------ | ----------- | --------------------------- |
| `lib/privacy/export-user.ts` | ✅ JSON, all columns     | ❌          | GDPR Art. 15                |
| `repo/subject-export.ts`     | ✅ all 17 brain tables   | ❌          | the brain half of the above |
| `vault/`                     | ✅ Obsidian markdown zip | ⚠️ lossy    | 6 of 19 tables, ~40 fields  |
| `lib/orchestration/backup/`  | ✅                       | ✅          | admin-wide, not per-user    |

The vault round-trip is the closest and is deliberately lossy: it exists so you
can edit notes in Obsidian, so it carries only `WRITABLE_KEYS`. Priority scores,
board layouts, time blocks, activity, and links with their tombstones are all
outside it.

## The governing rule

**Columns opt out. Models opt in.**

A new _column_ joins the bundle by default — the same rule
`lib/privacy/export-sources.ts` follows by using Prisma `omit` rather than
`select`, because an allowlist silently narrows every export as the schema grows.

A new _model_ joins nothing until somebody classifies it. The asymmetry is the
point: a table nobody has looked at, auto-added to an export, ships data nobody
reviewed; the same table auto-added to an _import_ writes rows nobody reviewed
into a real account.

## Where things live

```
prisma/generators/portability.mjs          the generator (runs on prisma generate)
lib/portability/model-graph.generated.ts   ~80 models, checked in
lib/portability/policy.ts                  the vocabulary
lib/portability/core-policies.ts           core + orchestration tables
lib/portability/registry.ts                assembles the three tiers
lib/framework/resparkable/transfer/policy.ts   the brain (data only, no imports)
lib/app/data-transfer.ts                   fork seam, ships empty
```

The engine lives in **core**, not in the framework tier, and treats the brain as
more models in the graph. A `repo/**` adapter would defeat the whole point —
either 19 hand-written functions, or the same dynamic client access relocated
with its typing lost — and it could not read `AiConversation` or `User` anyway. A
per-tier pair is ruled out by the data: `ResparkableReview.workflowExecutionId`
already crosses the boundary, and a topological order that stops at a tier cannot
resolve it.

The brain's policy file is **data only** — it imports no Prisma client and calls
nothing — so it sits inside the tier's ESLint boundary without an exemption.

## Dispositions

|               | Meaning                                          |
| ------------- | ------------------------------------------------ |
| `transfer`    | Leaves on export, written back on import         |
| `export-only` | In the bundle for the record, never written back |
| `skip`        | Never leaves. Requires a reason                  |

Three recurring decisions, made once:

**Credentials never move.** Sessions, OAuth tokens, password and API-key hashes
are `skip`. A key hash is not a record _about_ a key — it is what the server
compares against, so importing one makes the old key work in the new environment.

**Anything that can act on its own arrives switched off.** Webhooks, event hooks,
schedules and triggers transfer with secrets cleared and enabled flags forced
false. This generalises what the orchestration backup importer already does for
webhooks.

**History is `export-only`.** Executions, evaluation runs, audit logs, cost
records and the brain's own activity log go into the bundle — they are the user's
record — but are never written back. Re-importing them manufactures provenance:
a trace in a new environment describing a run that never happened there, beside
real ones and indistinguishable from them.

`AiWorkflowExecution` is `export-only` for a sharper reason: an inbound run
stores its raw trigger payload verbatim — sender addresses, message bodies,
attachments — so writing one into a _different_ environment would move
third-party data nobody asked to move.

## Merge keys

Identity resolves as `mergeKeys` → `softMergeKey` → always create. Every
`mergeKeys` tuple must correspond to a real unique constraint; the coverage guard
checks that against the graph, because a merge key with no constraint behind it
duplicates silently on every re-import.

| Model                             | Key                                                           |
| --------------------------------- | ------------------------------------------------------------- |
| Area, Project, Board, Tag, Entity | `[userId, slug]`                                              |
| Document                          | `[userId, fileHash]` — content-addressed, the only exact case |
| Thought                           | `[userId, externalId]` when non-null, else a soft key         |
| BoardCard, TaskTag, Link          | composite, evaluated **after** id remapping                   |
| Task                              | none — title is not identity                                  |
| **Goal**                          | **none exists**                                               |

`ResparkableTask` has no merge key deliberately. Two tasks with the same title
are usually two tasks; a duplicate is a minor annoyance, a wrongly merged one
loses notes and scheduling that cannot be recovered.

### ResparkableGoal has no unique constraint

It has no `slug` and no `@@unique`, so identity is a soft key —
`horizon | normalised title | target date` — and every match it makes is listed
individually in the dry run so it can be vetoed.

This is a real gap, not just a transfer inconvenience: `vault/import-plan.ts`
excludes goals from `SLUG_IDENTITY_TYPES` for exactly the same reason, so a
hand-written goal note already duplicates on every vault import today. Adding
`@@unique([userId, slug])` fixes both surfaces. Scheduled for Phase F.

## References the database does not enforce

The generated graph flags reference-shaped columns with no foreign key behind
them (`ModelNode.suspectedSoftRefs`). The guard fails until each is declared in
`softRefs` or dismissed in `softRefsIgnored` with a reason.

| Column                        | Target                                    | Unresolved                       |
| ----------------------------- | ----------------------------------------- | -------------------------------- |
| `Link.sourceId` / `.targetId` | polymorphic via `sourceType`/`targetType` | drop the row                     |
| `Thought.promotedToId`        | via `promotedToType`                      | null                             |
| `Review.workflowExecutionId`  | `AiWorkflowExecution` (export-only)       | null                             |
| `Event.entityId`              | anything                                  | kept — the log is never replayed |

The polymorphic type map is **derived** from `SEARCHABLE_ENTITY_TYPES` via the
`Resparkable<Name>` convention rather than written out, so making a new thing
linkable updates the remapping automatically. The guard checks every mapped name
against the real graph, which is the one way that derivation could go quietly
wrong.

## Json columns

Opaque to every tool we have, so each one needs a decision: `jsonRefs` if it
holds ids, `jsonOpaque` with a reason if it does not.

`ResparkableBoard.filter` gets a precise path (`projectId`) — and matters,
because a board with `membership: 'filter'` is a _live query_, so a stale id
renders it empty with no error. The dry run names every affected board rather
than counting them.

`ResparkableReview.payload` gets `path: '**'` — a whole-value scan against the
id-map. It is typed `unknown` on purpose ("each horizon carries a different
shape"), and it is writable by an agent, so any declared path would be correct
until the next renderer gained a field and then silently stop matching.

Backing both up: the **cuid canary**. During a dry run, every `Json` value is
walked for id-shaped strings that are keys in the id-map. Hits in undeclared
positions are reported, never rewritten — it tells you the declarations are
incomplete, using real data, which no static analysis can do.

## The secret guard

Every `String` column on a bundled model matching
`/token|secret|key|password|hash|credential|salt|signature|nonce|otp|private/i`
must be in `redact`, `regenerate`, or `secretReviewed` with a reason.

This is the counterweight to denylist auto-inclusion: a new `webhookSigningKey`
column lands in the bundle by default, and this is what stops it shipping.

The name pattern is deliberately broad; the **type** narrows it. Of 53 name
matches, about forty are token _counts_ (`maxTokens`, `costPerMillionTokens`) or
expiry timestamps. Requiring a written exemption for each would mean forty
rubber-stamped lines — and a guard people rubber-stamp is one that stops being
read. An `Int` named `maxTokens` cannot be an API key whatever it is called.

## What never round-trips

ids · owner columns · session and credential material · `inboxToken` ·
embeddings and tsvectors · `indexedHash` · `priorityScore` / `priorityFactors` ·
sweep cursors · `connectionStrengthFloor` · `storageKey` (rewritten) ·
share links and tokens · `leaseToken`.

`ResparkableTask.manualBoost` **does** transfer, despite the schema's "no agent
may write this". That rule is about agents; the boost is the user's own override
of the prioritiser and precisely the thing they would be angriest to lose.

## Phases

|     |                                                           | Status     |
| --- | --------------------------------------------------------- | ---------- |
| A   | Model graph, policy manifest, coverage guards             | ✅ shipped |
| B   | Export: collector, bundle writer, zip, route, UI          | planned    |
| C   | Brain formats: Logseq, Notion, CSV, single-file digest    | planned    |
| D   | Import, **dry-run only** — planner, id-map, orphan report | planned    |
| E   | Import apply, fresh mode only                             | planned    |
| F   | Merge mode + the `ResparkableGoal` unique migration       | planned    |
| G   | Document originals, background jobs, admin-initiated      | planned    |

E and F ship separately on purpose. Fresh-mode bugs are visible; merge-mode bugs
quietly attach data to the wrong parent and are found a month later.

## See also

- [`.context/database/model-graph.md`](../../database/model-graph.md) — the generated graph
- [`.context/privacy/data-export.md`](../../privacy/data-export.md) — the Art. 15 manifest this deliberately differs from
