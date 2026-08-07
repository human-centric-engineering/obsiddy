# Account transfer

Moving one person's data out of an account and into a different one — a new
account, or the same account on a self-hosted install.

**Status: Phases A, B and C shipped.** The model graph, the policy manifest, the
coverage guards, a working export — `GET /api/v1/users/me/transfer/export`, plus
the Your data tab in Settings — and five formats to write it out in. There is no
import yet; see [Phases](#phases).

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

lib/portability/collect.ts                 finds the rows (Phase B)
lib/portability/bundle.ts                  manifest + README, pure
lib/portability/archive.ts                 the zip
lib/portability/export-account.ts          the three, joined
app/api/v1/users/me/transfer/export/       the endpoint
components/settings/account-export-panel.tsx   Settings → Your data

lib/portability/format.ts                  the formats and what they promise (Phase C)
lib/portability/formats/json-bundle.ts     the default, as a format
lib/portability/formats/csv.ts             one CSV per table
lib/portability/formats/digest.ts          one Markdown document
lib/framework/resparkable/transfer/brain-view.ts       collected rows → typed brain
lib/framework/resparkable/transfer/formats/logseq.ts   a Logseq graph
lib/framework/resparkable/transfer/formats/notion.ts   a Notion import
```

The generic renderers live in **core** because nothing in them knows what a task
is: `csv` and `digest` work off the model graph and would render a fork's tables
as readily as ours. `logseq` and `notion` sit in the framework tier because they
speak the brain's vocabulary — a Logseq page for a rate-limit counter is not a
thing. Core's format registry imports the tier's two specs statically, exactly as
`registry.ts` already imports the tier's policy.

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

## What comes out

```
account-export-2026-08-07.zip
├── manifest.json         every table gathered and how, every one that was not and why,
│                         every column dropped, every column that will be reissued
├── README.md             the same thing in prose, for a reader with no session to log into
└── data/<Model>.json     one file per table with rows. A table with no rows gets a
                          manifest line and no file
```

One file per table rather than one document: a single large JSON file cannot be
opened by tools a person already has, cannot be diffed between two exports, and
forces an importer to parse all of it before it can report on any of it.

Archives are **reproducible** — one `mtime` across every entry, rather than
fflate's per-entry default of "now" — so two exports of an unchanged account
differ only where the account differs. Being able to diff two exports is how
anybody would ever notice this system quietly dropping a table.

## How the export finds the rows

Only 39 of the 57 exportable models carry an owner column. The rest are
somebody's only by way of something else that is, so `collect.ts` runs two
passes in two directions — and the asymmetry between them is the safety
property, not an implementation detail.

| Pass                | What it does                                                                              | Example                                  |
| ------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------- |
| **Down** (repeated) | Start at owner columns, then pull anything holding an FK into something already collected | `AiMessage` via its conversation         |
| **Up** (once)       | Pull the rows collected data _points at_                                                  | `AiCapability` behind a capability grant |

The up pass is **terminal**. It pulls shared, ownerless rows in and does not walk
back down from them, because one step down from `AiCapability` is every other
account's grants. A rule that simply alternated the two to a fixpoint would reach
them, and would look exactly as reasonable while doing it.

That is also why `ownerColumn` is authoritative rather than advisory: **a model
that declares an owner is only ever collected by asking for that owner's rows.**
`AiKnowledgeDocument.uploadedBy` is the case that makes this concrete — it is a
shared table holding many people's uploads, so without the rule, one of your
agents being granted somebody else's document would drag that person's row into
your bundle.

Anything neither pass reaches is **named in the manifest with a reason**. A
missing table and an empty table look identical in a file listing, and only one
of them is fine. Today that list is `AiCapability`, `AiKnowledgeBase`,
`KnowledgeTag` (nothing of yours names one), `McpServerConfig`,
`McpExposedResource`, `McpAuditLog` (its only route runs through `McpApiKey`,
which is `skip`), and `McpExposedTool` (reachable only by descending from a
shared row).

## `redact` and `regenerate` answer different questions

They were briefly conflated, and the export is what made the difference matter.

|              | Axis       | Meaning                                                  |
| ------------ | ---------- | -------------------------------------------------------- |
| `redact`     | disclosure | Dropped from the bundle. Not in the file at all          |
| `regenerate` | write      | In the file, never written — the target supplies its own |

A live credential needs `redact`. `regenerate` only stops a value being written
on the way _in_, and a secret's problem is on the way _out_: a bundle is a file
that gets emailed, synced and forgotten, and the value keeps working against the
installation it came **from** whatever an importer later does with it. This is
the same call `repo/subject-export.ts` already made when it omitted `inboxToken`
from the Art. 15 export "even though the subject owns it".

So `inboxToken`, `AiWorkflowTrigger.signingSecret`, `AiEventHook.secret` and
`AiWebhookSubscription.secret` are `redact`. `User.email`, `role`, `accountType`
and `image` stay `regenerate` — identity that belongs to wherever the data lands,
but not secret, and part of the record the user is owed.

The coverage guard enforces the split: it no longer accepts `regenerate` as an
answer for a secret-shaped column, and a second assertion fails on any policy
that tries.

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

## Formats

One collection, five renderings. A renderer receives the rows `collect.ts`
gathered and returns files; it never touches the database, so it inherits every
guarantee the collector makes rather than restating them. **A format cannot widen
what leaves an account**, which is what makes adding one a presentation decision
rather than a privacy one.

| `format` | Covers     | Reads back? | For                                      |
| -------- | ---------- | ----------- | ---------------------------------------- |
| `bundle` | everything | ✅ Phase D  | the record, and the only importable copy |
| `logseq` | brain      | ❌          | leaving for Logseq                       |
| `notion` | brain      | ❌          | leaving for Notion                       |
| `csv`    | everything | ❌          | opening in a spreadsheet                 |
| `digest` | everything | ❌          | reading, in one document                 |

`bundle` is the default, so every caller written before Phase C — and anybody who
bookmarked the URL — gets exactly what they got before.

### A format may narrow the sections, never widen them

`logseq` and `notion` declare `groups: ['brain']`. Asking one of them for
`?groups=brain,history` is a **400 naming the sections it cannot render**, not a
quiet intersection. The quiet version is the tempting implementation and it
produces an export that answers a narrower question than the one asked — which,
in a folder listing, is indistinguishable from those tables being empty. The UI
disables the sections a format does not cover, so the refusal is a backstop
rather than the way somebody finds out.

### Two transports, declared rather than inferred

Most formats are a folder and ship as a zip. `digest` is one document and is sent
as itself. `Rendering` is a discriminated union rather than "a zip unless there
happens to be one file", because the inferred rule would silently turn a CSV
export of a one-table account into a bare `.csv`.

### Tasks are blocks in Logseq and pages in Obsidian

The same data, deliberately shaped differently, because the target tools differ.
Obsidian's unit is the note, and `vault/export.ts` gives every task one. Logseq's
`TODO` blocks are what its agenda and query engine read, and a graph where every
task is a page has a thousand pages and an empty agenda. The cost is that a
Logseq task has no file of its own and so no identity a re-import could match —
acceptable, because the format is one-way by design and its README says so.

### Notion gets names, not ids

**Notion does not create relations on import.** A column of `clx0k3…` arrives as
text that sorts, filters and means nothing, so every reference is written as the
_name_ of its target: a task's `Project` says "Website rebuild". Those columns
convert to real relations in a couple of clicks. The loss — two projects with the
same name become indistinguishable — is stated in the export's own README, and
the ids are all still in the bundle.

### The digest is a summary and says so

Every table prints its true row count and how many records are shown, and the
omitted ones are counted out loud. The rule everywhere else here is that a short
answer must announce that it is short; the digest is the one place a short answer
is the _intended product_, which makes announcing it more important rather than
less. Which columns appear is not guessed at from names — the model graph already
knows which are ids, foreign keys, `Json` or reference-shaped, and what is left
in schema order is the answer.

### Rows become typed exactly once

`brain-view.ts` is the only place `Record<string, unknown>` becomes a task, and
it happens through Zod rather than an `as`. Schemas take the handful of columns a
renderer uses and ignore the rest, so a new column cannot break an export; a row
that genuinely will not parse is **counted and skipped**, and the count is
printed in the rendering. One bad row in nine thousand must not cost somebody
their whole export, and a renderer that silently produced 8,997 notes from 9,000
tasks would be indistinguishable from one that worked.

Only `accepted` links are drawn. A `suggested` link is a machine's guess nobody
has looked at and a `rejected` one is a tombstone that exists to stop the guess
coming back — neither is the user's own thinking, and a fresh graph full of both
would be our unfinished business wearing their notes' clothes.

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
| B   | Export: collector, bundle writer, zip, route, UI          | ✅ shipped |
| C   | Brain formats: Logseq, Notion, CSV, single-file digest    | ✅ shipped |
| D   | Import, **dry-run only** — planner, id-map, orphan report | planned    |
| E   | Import apply, fresh mode only                             | planned    |
| F   | Merge mode + the `ResparkableGoal` unique migration       | planned    |
| G   | Document originals, background jobs, admin-initiated      | planned    |

E and F ship separately on purpose. Fresh-mode bugs are visible; merge-mode bugs
quietly attach data to the wrong parent and are found a month later.

## See also

- [`.context/database/model-graph.md`](../../database/model-graph.md) — the generated graph
- [`.context/privacy/data-export.md`](../../privacy/data-export.md) — the Art. 15 manifest this deliberately differs from
