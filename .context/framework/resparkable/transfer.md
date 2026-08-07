# Account transfer

Moving one person's data out of an account and into a different one — a new
account, or the same account on a self-hosted install.

**Status: Phases A–F shipped.** The model graph, the policy manifest, the
coverage guards, a working export — `GET /api/v1/users/me/transfer/export`, plus
the Your data tab in Settings — five formats to write it out in, and a working
import: `POST /api/v1/users/me/transfer/import` says what a bundle would do, and
with `apply=true` does it. Both conflict modes: `skip` leaves a record already
here alone, `overwrite` writes the bundle's values into it — but only where the
match came from a real unique constraint, never from a guessed key. See
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

lib/portability/read-bundle.ts             an uploaded zip → rows (Phase D)
lib/portability/write-order.ts             what has to exist before what
lib/portability/json-paths.ts              the path walker and the cuid canary
lib/portability/import-plan.ts             the planner. Pure — no DB
lib/portability/import-lookup.ts           the owner-scoped reads it asks for
lib/portability/import-account.ts          the three, joined
app/api/v1/users/me/transfer/import/       the endpoint

lib/portability/apply-import.ts            writes a plan (Phase E)
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
| Goal                              | `[userId, slug]` — see below                                  |

`ResparkableTask` has no merge key deliberately. Two tasks with the same title
are usually two tasks; a duplicate is a minor annoyance, a wrongly merged one
loses notes and scheduling that cannot be recovered.

### ResparkableGoal gained a slug in Phase F

It used to have neither a `slug` nor a `@@unique`, so identity was a soft key —
`horizon | normalised title | target date` — and every match it made was listed
individually in the dry run so it could be vetoed.

That was never only a transfer inconvenience. `vault/import-plan.ts` excluded
goals from `SLUG_IDENTITY_TYPES` for the same reason, so a hand-written goal note
created a **second** goal on every vault import, for ever. And the vault had
always filed a goal at `Goals/<horizon>/<slug>.md`, recomputing that slug from
the title on the way out and throwing it away — so the address already existed
and was simply not stored.

`slug String` plus `@@unique([userId, slug])` fixed both surfaces at once
(`20260807220000_resparkable_goal_slug`, which backfills with the same rule
`services/slug.ts` mints by, de-duplicates the way `resolveUniqueSlug` does, and
then adds the index). The soft key is **gone rather than kept as a fallback**, so
there is exactly one answer to "is this the same goal?" and it is the same answer
the vault importer gives.

Two knock-on rules worth knowing, both matching what projects and entities
already did: the agent-facing `resparkable_upsert_goal` does not accept a slug
(the service derives it from the title), and a retitle does **not** move the slug
— `resolveSlugOnUpdate` leaves it alone, because the slug is the address of a
file in somebody's vault.

This constraint is what made `conflictMode: 'overwrite'` possible; see
[the two conflict modes](#the-two-conflict-modes).

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
| `bundle` | everything | ✅          | the record, and the only importable copy |
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

## Reading a bundle back

`POST /api/v1/users/me/transfer/import` takes a bundle and returns **what it
would do**. Nothing is written. That is Phase D's whole scope and it is a
stopping point rather than an unfinished one: the plan is the artefact somebody
reads before agreeing to anything, and it is the only way to find out what a
bundle from a different installation would do to this one without finding out
the expensive way.

Only the `bundle` format can be read. A Logseq graph or a digest is a one-way
rendering, and the refusal says so by name rather than failing on a missing file.

### The plan is the thing that gets applied

`import-plan.ts` reaches no database. It asks two questions through a port —
_do you already have a row with this merge key_, and _give me your rows of this
model_ — so the whole planner runs in unit tests against a hand-written lookup
with no mocks. `apply-import.ts` applies a plan; it does not compute a second one,
so "show me what this would do" and "do it" cannot disagree.

### The rule that is a security property

**A bundle's owner column is overwritten, never read.** Every row lands on the
account doing the importing, whatever the file says. Ids are treated the same
way — a row's `id` is only a key into this run's id-map, and whether anything
lands on an existing row is decided by a merge key looked up through an
owner-scoped read.

`import-lookup.ts` is where that scoping is enforced, and it refuses to query a
model that has neither an owner column nor a merge key made of already-remapped
foreign keys. Without that refusal, a hand-edited bundle could probe for another
account's rows by guessing keys and be told which ones exist.

### One pass, then one read-only sweep

Tables are visited in dependency order, and **soft and `Json` references count as
dependencies** — not just real foreign keys. So by the time a model is reached,
every id it could name has already been decided, and identity, remapping and the
drop cascade all fall out of the single walk: a dropped row never enters the
id-map, so its children find nothing when their turn comes.

The order is a topological sort over the generated graph, not a hand-maintained
list. A hand-maintained list would not notice a new relation, and the failure
would be an import attaching somebody's tasks to nothing.

Three things cannot be known during that walk, and they are exactly the three
that act on nothing — a reference into a row's own table (`parentGoalId`), an
edge deferred to break a cycle, and a `'**'` `Json` reference. All three are
nullable or `keep`, so resolving them in a final sweep can change a value but
cannot change whether a row exists. The canary runs there too, because it needs
the finished id-map to know what an id looks like.

The owner column is followed for **ordering** even though it is exempt from
remapping: every brain table's `userId` is a real foreign key into
`ResparkableSpace`, so dropping that edge would order the space after everything
hanging off it.

### What the plan reports

|                           |                                                                         |
| ------------------------- | ----------------------------------------------------------------------- |
| per table                 | creates, matches, soft matches, drops, columns that will not be written |
| **soft matches**          | named individually — a guess must be vetoable                           |
| **orphans**               | every reference that went nowhere, with what happens to it              |
| **canary**                | ids found in `Json` positions the manifest does not declare             |
| **contested**             | two records wanting one existing row                                    |
| **unknown / not written** | tables with no policy here, and tables classified as never written back |

Detail lists are capped at 200 and **every one carries its true total**. A plan
that quietly showed the first two hundred orphans would read as a plan with two
hundred orphans, which is the same failure the digest format guards against and
worse on the way in: on the way out it costs somebody data, on the way in it
silently changes what they agreed to.

### Two records never merge onto one row

The second becomes a new row and is reported. Never merge both, never let the
last one win: a duplicate is recoverable and an overwrite is not.

### The same bundle always plans the same way

No clock, no randomness, sorted tie-breaks — and every database read the planner
depends on carries an `orderBy`. The last one is easy to leave out and matters
most: the soft-key index keeps the **first** row it sees for each key, so an
account holding two goals with one title, one horizon and one target date would
otherwise pick between them on whatever order Postgres felt like. `collect.ts`
exports `orderById` and the lookup uses it, so both halves of the subsystem order
the same way.

Determinism is what a plan being worth approving rests on. An apply re-runs this
planner rather than stashing one — a two-million-row plan cannot be held between
two requests — so anything that could resolve
differently on the second run is a difference between what somebody agreed to and
what happens.

### The canary reports; it never rewrites

A finding says the manifest needs an edit, not that the planner should guess. The
path it reports is relative to the column, which is the form a `jsonRefs`
declaration takes — so `{ column: 'columns', path: '[].projectId' }` can be
pasted straight into the policy.

### Reading untrusted bytes

`read-bundle.ts` is the first thing in this subsystem whose input it did not
write. The realistic attack is expansion rather than traversal — fflate has no
filesystem contact, so zip-slip is structurally impossible — so the caps run
**inside the filter callback**, which fflate calls with each entry's declared
size before decompressing it. Only `manifest.json` and `data/*.json` are ever
inflated, and every cap breach rejects the whole archive rather than truncating
it.

A bundle is a zip somebody can edit, and the two edits that matter both produce
an archive that looks entirely normal in a listing: adding a data file the
manifest does not vouch for, and deleting one it does. Both are **reported**, and
a file the manifest never mentions is ignored — otherwise "models opt in" would
mean "models opt in unless you unzip the bundle first".

## Writing a plan

`apply-import.ts` is the only thing in this subsystem that changes anything, and
it makes no decisions. What matches what, what is created, what was dropped for
want of a reference — all of it arrives on `ImportPlan.resolved`, which the
planner assembled from the same state it counted the report from. There is no
identity logic in the applier to disagree with the dry run's, because there is
none there at all.

### Every id is minted before anything is written

The obvious implementation inserts a table, reads the generated ids back, and
uses them for the next one. That means trusting the order a bulk insert returns
rows in, which no database contract promises — and a permutation would attach
somebody's tasks to the wrong project, violate no constraint, and be found never.

So ids are generated up front and the id-map is complete before the first row
lands. Nothing depends on result ordering, and `createMany` becomes usable, which
is what keeps a large import to a handful of round trips.

`crypto.randomUUID()` rather than a cuid: standard library, no new dependency for
a starter template, and no hand-rolled entropy. Imported rows therefore carry
uuid-shaped ids beside the app's own cuids — visible in the database and nowhere
else, because nothing here parses the shape of an id.

### One transaction, and a cap that refuses

A half-applied import is the worst artefact this could produce: rows attached to
parents that exist, beside rows whose parents never arrived, and nothing to say
which is which. So it is one transaction, which bounds what it can carry —
`APPLY_CAPS.maxRows` refuses above the limit rather than streaming. Importing an
account too large for one request is Phase G.

### What is never created

A model whose owner column **is** its primary key describes the account rather
than something the account owns. `User` is the case, and its policy sets
`ownerColumn: 'id'` precisely so an import "lands on the account doing the
importing rather than creating a person". Those rows are never written, matched
or not — the alternative is an insert carrying the importer's own id, colliding
with the row it failed to match.

### `mint`: the gap `redact` opens

A redacted column is dropped on the way out, which is right for a live
credential. But a column that is **required and undefaulted** then has no value
at all on the way in, and the table cannot be written.

`ResparkableSpace.inboxToken` is the case — a bearer token routing somebody's
email capture. `mint` is how a policy supplies one: a function, in the tier that
owns the column, so token length and alphabet stay decisions of the code that
reads it. The coverage guard now requires a `mint` (or a `reset`) for every
column that is redacted, required and undefaulted, which is the only combination
that silently yields an import unable to write a table.

That combination was found by an apply that could not create a space. The guard
is the cheap way to find the next one.

### Getting values back out of JSON

A bundle went through JSON to get here, so every date is a string, every `BigInt`
is a string and every `Bytes` is base64 — the inverse of what `bundle.ts` encodes
on the way out. Coercion is driven off the generated graph rather than off the
shape of the value, because `"2026-08-07"` is a perfectly good string until the
column it is going into disagrees.

### The second pass

A row pointing into its **own** table cannot be written in one go: the foreign
key is checked as each row lands, so a child written before its parent fails even
inside one statement. Those columns are held back and set afterwards, by id.
Cycle-breaking deferred edges take the same route.

## What never round-trips

ids · owner columns · session and credential material · `inboxToken` ·
embeddings and tsvectors · `indexedHash` · `priorityScore` / `priorityFactors` ·
sweep cursors · `connectionStrengthFloor` · `storageKey` (rewritten) ·
share links and tokens · `leaseToken`.

`ResparkableTask.manualBoost` **does** transfer, despite the schema's "no agent
may write this". That rule is about agents; the boost is the user's own override
of the prioritiser and precisely the thing they would be angriest to lose.

## Phases

|     |                                                                               | Status     |
| --- | ----------------------------------------------------------------------------- | ---------- |
| A   | Model graph, policy manifest, coverage guards                                 | ✅ shipped |
| B   | Export: collector, bundle writer, zip, route, UI                              | ✅ shipped |
| C   | Brain formats: Logseq, Notion, CSV, single-file digest                        | ✅ shipped |
| D   | Import, **dry-run only** — planner, id-map, orphan report                     | ✅ shipped |
| E   | Import apply, `conflictMode: 'skip'` only                                     | ✅ shipped |
| F   | `conflictMode: 'overwrite'` + the `ResparkableGoal` unique migration it needs | ✅ shipped |
| G   | Document originals, background jobs, admin-initiated                          | planned    |

### The two conflict modes

`conflictMode` answers one question: **when a record in the bundle matches one
the account already has, what happens to the record already here?**

|             |                                                                                |
| ----------- | ------------------------------------------------------------------------------ |
| `skip`      | It is left exactly as it is. Nothing is written into it. **The default.**      |
| `overwrite` | The bundle's values are written into it — if the match came from a constraint. |

`skip` is the default because the two are not symmetrical: the worst `skip`
produces is a duplicate, and the worst `overwrite` produces is data that used to
be there and now is not.

Both are `lib/validations/orchestration.ts`'s words: the agent importer already
takes a `conflictMode` with exactly these two values. Reusing them means one
vocabulary for one question across the whole codebase.

Note that `mergeKeys` and `conflictMode` are not two halves of one idea, and it
is worth keeping them apart. The keys are how a collision is **found**; the mode
is what is **done** about it. Calling the write-into-it mode "merge" would blur
precisely that.

An earlier draft called these `create` and `merge`. Implementing Phase E showed
`create` up: a colliding record cannot be created — the unique constraint that
detected the collision would reject it — so `create` was describing what happens
to the records that _don't_ collide, which is the one thing `conflictMode` is not
about. That is the same defect as the "fresh mode" it replaced.

### What `skip` does with a collision

It leaves the row alone **and points everything that referred to the bundle's
copy at the row already here.** So importing an export into an account that
already has an area called Health files the bundle's projects under the existing
Health, rather than creating a second one.

That matters more than it sounds: `User` and `ResparkableSpace` collide on every
import by construction — you cannot create a second you, and the space is unique
per user — so a mode that could not resolve a collision to something usable could
not import anything at all.

Identity resolution runs the same way in both modes (`mergeKeys` → `softMergeKey`
→ create); only what is done with the result differs. The dry run reports
`matches` without a mode to act on them, which is why a plan is comparable across
modes.

### What `overwrite` does with a collision

The same remapping as `skip` — children still attach to the row that is here —
and then it writes the bundle's values into that row. With three exceptions, and
they are the whole of the mode's safety:

| Not written on an overwrite | Why                                                                                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a `soft-match`ed row        | The key that found it is a guess. Left exactly as `skip` leaves it, and still listed in the plan.                                                                                         |
| `mint` columns              | Minting is how a redacted column gets a value at all; doing it to an existing row **rotates a live credential**. An import must not silently move where somebody's email capture arrives. |
| the owner column            | The row was found through an owner-scoped read, so it already belongs here — and where the owner column _is_ the primary key (`User`), writing it would be an attempt to move the row.    |

`regenerate` is excluded in both modes, and that is what keeps this from being a
one-file privilege escalation: `role`, `email` and `emailVerified` belong to
wherever the data lands. `reset` columns _are_ still forced, so a row that was
written into is re-indexed rather than left with a digest describing its old text.

E and F shipped separately on purpose. Under `skip` the worst bug is a duplicate —
visible, and deletable. Under `overwrite` the worst bug writes somebody's data
into the wrong existing row, which is neither, and is found a month later. It is
the same trade `ResparkableTask` already makes by declaring no merge key at all.

That is also why `overwrite` needed the
[`ResparkableGoal` unique constraint](#resparkablegoal-gained-a-slug-in-phase-f)
first, and why the two are one phase: writing into a row matched by a key with no
constraint behind it is writing into a guess. Goals were the last table in the
brain whose identity was a guess and whose contents somebody would miss.

The applier counts the two apart: `ApplyResult` reports `created`, `overwritten`,
`skipped` and `dropped` separately, because "how much arrived" and "how much of
what was already here changed" are different questions. Overwrites count against
the same `APPLY_CAPS.maxRows` as inserts — an overwrite is the more expensive of
the two, being one round trip each where inserts go a thousand at a time.

## See also

- [`.context/database/model-graph.md`](../../database/model-graph.md) — the generated graph
- [`.context/privacy/data-export.md`](../../privacy/data-export.md) — the Art. 15 manifest this deliberately differs from
