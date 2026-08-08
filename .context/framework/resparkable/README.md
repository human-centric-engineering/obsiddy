# Resparkable — framework-tier docs

Resparkable is a **framework-tier module**: a reusable layer between Sunrise and the leaf forks that install it. Sunrise reserves this tier (`CUSTOMIZATION.md` § "Two reserved fork tiers") and never writes to it, so Sunrise upgrades merge cleanly underneath.

## Where Resparkable's things live

| Concern    | Path                                                          |
| ---------- | ------------------------------------------------------------- |
| Code       | `lib/framework/resparkable/**`                                |
| Schema     | `prisma/schema/framework-resparkable.prisma`                  |
| Tables     | `framework_resparkable_*`                                     |
| Seeds      | `prisma/seeds/framework-resparkable/001-*.ts` onward          |
| Docs       | `.context/framework/resparkable/**` (this folder)             |
| Routes     | `app/(protected)/resparkable/**`, `app/api/v1/resparkable/**` |
| Components | `components/resparkable/**`                                   |

Namespaced _inside_ the tier, never at its root — so a project already running another framework layer can add Resparkable as a sibling rather than colliding.

## The two rules

1. **Resparkable touches zero Sunrise-owned files** — as of the 2026-07-31 upstream merge, this is literally true rather than aspirational. Every such edit is a merge conflict inflicted on every host project. The two seams that were missing landed upstream: `lib/app/jobs.ts` + `registerAppJob` ([sunrise#469](https://github.com/human-centric-engineering/sunrise/issues/469)) and `lib/app/protected-nav.ts` ([sunrise#473](https://github.com/human-centric-engineering/sunrise/issues/473)). Neither carries the name `plan.md` proposed for it.
2. **Seeds number from `001` inside `prisma/seeds/framework-resparkable/`.** The runner discovers seeds recursively and `SeedHistory` keys on the path relative to `prisma/seeds/`, so Resparkable's numbering cannot collide with a host's own seeds.

## Contents

| File                                   | What it is                                                                                                                                                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`plan.md`](./plan.md)                 | The full implementation plan — data model, migrations, API, agents, workflows, prioritisation, lifecycle, boards, sharing, Obsidian sync, **Cross-Pollination (§18)**, phasing, verification, risks                    |
| [`install.md`](./install.md)           | How a host Sunrise project installs Resparkable — tier directories, one-line seam registrations, env vars, migration, verification. Kept current by every phase                                                        |
| [`ui.md`](./ui.md)                     | The UI's rules and why each exists — one fetch per surface, read/mutate split, wire-shape parsing, the fork-owned primitives, and the checklist for adding a surface                                                   |
| [`agents.md`](./agents.md)             | The agent layer's rules — one truth for four places, the owner-scope guard, what an agent deliberately cannot do, the redaction line, the five agents, and why bindings are the enforcement                            |
| [`mcp.md`](./mcp.md)                   | What the brain exposes over MCP and why that list _is_ the access control — the `scopedAgentId` gotcha, the eight tools, the three prompts, the operator setup, and why resources are deferred                         |
| [`evaluations.md`](./evaluations.md)   | How you find out triage has got worse — the thirty cases, the 0.5/0.5 score, and why the runner is a script rather than a batch run                                                                                    |
| [`dev-proxy.md`](./dev-proxy.md)       | Why dev runs on `https://resparkable.test` not `localhost:3016` — the shared HCE proxy registry, the port that must agree in two places, the `herd unproxy` step `apply.sh` won't do, why Google login can't work here |
| [`sunrise-asks.md`](./sunrise-asks.md) | What Resparkable needs from upstream Sunrise — missing seams, core files a fork is forced to edit, platform gaps. Every row also gets an issue on the Sunrise repo                                                     |

`plan.md` is the working copy that travels with the code. It is not auto-synced with any copy held outside the repository.

## Status

**Release 1, phases 0–8 and 7b complete** — the tier is wired, the data model exists, every core type has an owner-scoped CRUD API, tasks are ranked by a deterministic scorer, the brain is searchable by meaning, there is a UI (fourteen surfaces at `/resparkable`, including a kanban board), and **you can now talk to it**: eighteen capabilities, six agents, the shared profile they inherit, a per-turn context block that means the agent already knows your goals, and a chat page at `/resparkable/chat`. Phase 7 added the background: four workflows on per-user schedules, the
connection sweep as an app job, the morning briefing, and the tier's first
erasure hook. Phase 8 added the lifecycle: retention on the same rotation, the
stale digest, and the archive surface. Phase 7b took it **outside the app**:
eight tools and three prompts over MCP (zero code — see [`mcp.md`](./mcp.md)), an
iOS Shortcut recipe, and a thirty-case triage benchmark with a deterministic
grader ([`evaluations.md`](./evaluations.md)). Next is phase 9 — the PWA, voice
and image capture, and email-to-inbox — which closes Release 1.

| Wired                                   | Where                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Boot (dynamic import → `initLeafApp()`) | `lib/app/bootstrap.ts` → `lib/framework/resparkable/index.ts`                                                                                                                                                                                                                                                                                                                  |
| Env schema                              | `lib/app/env.ts` merges `resparkableEnvSchema` (currently empty)                                                                                                                                                                                                                                                                                                               |
| Lint boundary                           | `lib/app/eslint.config.mjs` spreads `lib/framework/eslint.config.mjs`                                                                                                                                                                                                                                                                                                          |
| Protected route                         | `/resparkable` in `lib/app/protected-routes.ts`                                                                                                                                                                                                                                                                                                                                |
| Rate-limit sub-caps                     | `lib/app/rate-limit.ts` → `registerResparkableRateLimits()` (search, reindex, sweep, upload, ideate, chat, briefing regenerate, vault — eight)                                                                                                                                                                                                                                 |
| Admin nav                               | `lib/app/admin-nav.ts` → `registerResparkableAdminNav()`                                                                                                                                                                                                                                                                                                                       |
| Drift probes                            | `lib/app/db-drift.ts` → `registerResparkableDriftProbes()` (six, B1 + B3–B7)                                                                                                                                                                                                                                                                                                   |
| Protected nav                           | `lib/app/protected-nav.ts` spreads `RESPARKABLE_NAV_ITEM` — was a core-file edit until sunrise#473 landed 2026-07-31                                                                                                                                                                                                                                                           |
| App jobs                                | `lib/app/jobs.ts` → `registerResparkableJobs()` — one rotation, three passes: connection sweep and schedule pass (7), retention (8)                                                                                                                                                                                                                                            |
| Erasure hook                            | `initResparkable()` → `registerResparkableErasure()` — the tier's first, because phase 7 is the first time it writes to a table outside the cascade                                                                                                                                                                                                                            |
| Workflows                               | `prisma/seeds/framework-resparkable/005-workflows.ts` — four, on per-user schedules from `ensureResparkableSchedules()`                                                                                                                                                                                                                                                        |
| Schema                                  | 19 models in `prisma/schema/framework-resparkable.prisma`                                                                                                                                                                                                                                                                                                                      |
| Migrations                              | `add_second_brain`, `resparkable_space_cascade`, `resparkable_document_originals`, `resparkable_sweep_cursor`, `resparkable_document_hash_unique`, `resparkable_connection_floor`, `resparkable_space_sweep_cursor` — all hand-edited, never regenerate                                                                                                                        |
| Repo layer                              | `lib/framework/resparkable/repo/*` — `OwnerScope`, 26 modules (`retention` and `stale` in phase 8)                                                                                                                                                                                                                                                                             |
| Capabilities                            | `lib/app/capabilities.ts` → `registerResparkableCapabilities()` (eighteen; fourteen in 6b, three in 7, the stale digest in 8)                                                                                                                                                                                                                                                  |
| Services                                | `lib/framework/resparkable/services/*` — resources, slug, events, space, snooze, today, inbox, promote, details, graph, connections-view, board-view, board-export, fractional-position, counts, link-hydration, **capture, snapshot, ideate, reviews, links** (phase 6a), **neighbours** (6b), **briefing, briefing-facts, recent-wins** (7), **retention, stale-digest** (8) |
| Agent layer                             | `lib/framework/resparkable/capabilities/*` — catalogue, scope guard, eighteen handlers; seeds in `prisma/seeds/framework-resparkable/001–005`                                                                                                                                                                                                                                  |
| Priority engine                         | `lib/framework/resparkable/priority/*` — pure scorer, batched reprioritise pass                                                                                                                                                                                                                                                                                                |
| Semantic layer                          | `lib/framework/resparkable/{embedding,search,documents}/*` — indexer, hybrid search, sweep, ingest                                                                                                                                                                                                                                                                             |
| Zoned time                              | `lib/framework/resparkable/time/zoned.ts` — every schedule resolves in the user's zone                                                                                                                                                                                                                                                                                         |
| UI contracts                            | `lib/framework/resparkable/ui/*` — `RESPARKABLE_ROUTES`, wire-shape schemas, the one server-read helper                                                                                                                                                                                                                                                                        |
| API                                     | `app/api/v1/resparkable/**` — 70 route files, plus one admin pair (`GET`/`PATCH` on `admin/resparkable/settings`)                                                                                                                                                                                                                                                              |
| User UI                                 | `app/(protected)/resparkable/**` — 14 surfaces; components in `components/resparkable/**`                                                                                                                                                                                                                                                                                      |
| MCP exposure                            | `prisma/seeds/framework-resparkable/006-mcp.ts` from `lib/framework/resparkable/mcp/exposure.ts` — eight tools, three prompts, **no code** (phase 7b)                                                                                                                                                                                                                          |
| Vault (Obsidian)                        | `lib/framework/resparkable/vault/*` — layout, markdown codec, frontmatter schemas, note encoders, zip transport, export, pure import planner, apply (Release 3, phase 15 + the zip half of 17)                                                                                                                                                                                 |
| Account transfer (policy)               | `lib/framework/resparkable/transfer/policy.ts` — every brain table classified for account export/import: dispositions, merge keys, soft references and `Json` id paths. Data only, no imports, so it sits inside the tier's Prisma boundary. Engine and guards live in core `lib/portability/*`; see `.context/framework/resparkable/transfer.md` (Phase A)                    |
| Evaluation                              | `lib/framework/resparkable/evaluations/*` — thirty triage cases, the `resparkable_triage_accuracy` grader, dataset in `007-eval-dataset.ts`, runner at `npm run framework:resparkable:eval-triage` (phase 7b)                                                                                                                                                                  |
| Admin UI                                | `/admin/resparkable/settings` — document handling and the upload ceiling                                                                                                                                                                                                                                                                                                       |

## The UI, and the rules it follows (phase 5)

Fourteen surfaces under `app/(protected)/resparkable/`: Today, Inbox, **Chat**,
Search, Projects (+ detail), Goals, Areas, People (+ detail), Documents,
Connections, Graph, Boards (+ board), Plan, Settings, **Archive** (phase 8).

Archive is the one deliberately absent from the nav. §11 makes the archived list
views and `?includeArchived=true` the only two ways to reach archived items, and
a permanent link to your own archive puts the things you decided to stop thinking
about back in front of you every day — the opposite of what archiving is for. It
is linked from Settings and from the monthly review, both places you go on
purpose.

Four rules shape all of them, and each exists because breaking it is invisible:

1. **One enriched fetch per surface, never one per row.** `/today`, `/inbox`,
   `/connections`, `/graph`, and the four `/view` endpoints each assemble a page in a
   bounded number of queries. The route tests assert the query _count_, because an
   N+1 regression changes nothing you can see — it just quietly becomes thirty
   requests.
2. **Server components read; client components mutate.** A page fetches through
   `readResparkable` and hands the payload to a `'use client'` child. Pages read through
   the **API**, not the services directly: it costs one localhost request and it means
   there is exactly one implementation of "what does this surface show", exercised by
   the web UI, the agent layer and MCP alike.
3. **Wire shapes are parsed, not cast.** `ui/payloads.ts` describes what arrives
   _after_ `JSON.stringify` — every `Date` is a string. A component typed with a
   service's return type would be lying, and the lie surfaces as
   `dueAt.getTime is not a function` rather than a type error.
4. **Missing primitives are built, not installed.** No toast (an `aria-live` status
   line), no skeleton (`animate-pulse`), no progress (`role="progressbar"`), no
   generic data table. Three new dependencies total: `d3-force` for graph layout,
   `@dnd-kit/core` + `@dnd-kit/sortable` for the board.

Two things the UI says out loud because nothing else would:

- **An area with no weekly target does not participate in balancing at all**, and
  targets summing past your weekly capacity make every area read as neglected —
  which flattens the term rather than sharpening it.
- **A sweep that stopped at its cap looks exactly like a sweep that found
  everything.** `cappedTypes` and the graph's `truncated` are rendered prominently
  for that reason.

## The isolation contract (D5)

Everything in the brain is an **owner query**. `OwnerScope` is a branded type minted only from a verified session id, every repo function takes one, and three boundaries keep it honest:

1. `repo/**` may not import `access/**` (cross-user resolution, Release 2).
2. Nothing in the tier except `repo/**` may import Prisma at all.
3. Every create/update/delete targets `{ id, userId }` together, so another user's id matches no row — **404, never 403**, because a 403 confirms the row exists.

Proven by `npm run framework:resparkable:smoke-isolation` against a real database: 27 assertions covering cross-user reads, writes, archive, restore, delete, dedupe and the erasure cascade.

## How ranking works (D3)

`priorityScore` is **written, not computed per request**. A pure function over six weighted factors plus an additive `manualBoost` produces the number; every list endpoint is then one indexed `ORDER BY` with zero per-request work. An LLM chooses among the top few and writes rationales — it never produces a number that lands in the column.

Three properties the tests hold, because each is invisible when it breaks:

1. **`manualBoost` is applied additively after the weighted sum**, never as a seventh weighted term. That is what makes `+1` provably outrank every unboosted task, and it only holds while `base` stays inside `[0, 1]` — which is why the weights must sum to 1 and are normalised defensively on read.
2. **An expired boost reads as `0` at evaluation time**, never lazily zeroed by a background job. A pin set in March and forgotten stops applying the moment it expires, whether or not anything has run since.
3. **Every scheduling phrase resolves in `ResparkableSpace.timezone`.** "Tomorrow at 9am" from the web, a phone and an agent must mean one instant, and a day is 23 or 25 hours long twice a year.

Scores are refreshed on every task mutation, and phase 7's nightly triage adds the full pass — so a task whose score depends on something _else_ changing (a project going quiet, a week rolling over) is now re-scored overnight rather than waiting to be touched.

## How search works (D2, D4)

**One vector table, one re-embed path.** `ResparkableEmbedding` holds every embedded type (`thought | project | goal | area | entity | document`), so there is a single `vector(1536)` column to drift-probe instead of six. `task` is deliberately absent — task titles are short and semantically thin, so they are searched through a generated tsvector (probe B4) instead.

**Search is exact, not approximate — the HNSW index is not on the query path.** Verified with `EXPLAIN` (2000 rows, `enable_seqscan = off`): the hybrid query plans as an index scan on `(userId, entityType)` plus a sort. pgvector's HNSW index only serves a bare `ORDER BY embedding <=> $1 LIMIT n`, and the two things that make this query useful — the distance pre-filter and the _blended_ ranking — both defeat it. That is the right trade at personal scale (exact distance over one user's few thousand chunks is perfect recall for a few milliseconds, where ANN would approximate for no gain), but it means the index currently protects a future rather than a present. Restructuring the query to use it changes recall semantics and is therefore a decision for a later phase, not a tidy-up.

Six properties, each invisible when it breaks:

1. **All vector SQL lives in `repo/embeddings.ts`.** The plan put `searchResparkable` in `search/`, but the tier lint boundary forbids Prisma outside `repo/**` — and that constraint is worth more than the file layout, because it means the raw SQL, the one place a `WHERE "userId"` can be forgotten, can only be written in the layer whose every function takes an `OwnerScope`. `search/*` orchestrates; it cannot query.
2. **`indexedHash` is nulled liberally; the hash comparison is the cost gate.** Every update, restore and manual reindex nulls it — which queues a _comparison_, not an API call. (This was the design from the start and, until a review caught it, no `update*` path actually did it: edited notes kept their old vectors and old search snippets permanently. The repos now force `indexedHash: null` on every update, which is why the claim is finally true.) The indexer computes the canonical hash, checks it against what is stored, and only then spends anything. That is what lets a mutation path null the column without knowing which fields are semantic, and what keeps a corpus of five thousand notes from re-embedding because a status changed (§17 risk 3). `indexer.test.ts` asserts the call count on the embedder, both ways round.
3. **Archiving deletes the embedding rows in the same transaction as the archive.** An archived item left in the index behind a `WHERE archivedAt IS NULL` filter would make recall degrade silently as history grows — no error, no symptom (§17 risk 5b). The consequence is that the archived corpus has _no vectors at all_, so `?includeArchived=true` is served by a keyword pass instead. That is a deliberate trade, not a gap.
4. **The connection sweep costs nothing per run.** It reads _already-stored_ vectors and finds neighbour pairs in SQL (D4), so proactive connection-hunting can be left on forever; an LLM writes rationales later, only for pairs that cleared the similarity floor. Pair exclusion — including the `rejected` tombstone, in **both** directions — happens in the query, so no caller can forget it and re-nag someone every Sunday (§17 risk 5c).
5. **The sweep's per-type cap rotates.** Candidates are ordered by `sweptAt` (nulls first) and every examined id is stamped, so a capped run resumes where the last one stopped. The obvious ordering — most-recently-embedded — would have re-examined the same 200 rows for ever, leaving a 900-project corpus 78% unreachable while the log claimed it had merely stopped early.
6. **The similarity floor is 0.55, measured rather than assumed.** The plan specified 0.72; against the default embedding model (`text-embedding-3-small`) that sits _above_ the signal — the flagship "same idea, different words" pair scores 0.679, so the engine proposed nothing at all, silently and for ever. 0.55 admits it and still rejects the loosely-related (0.31–0.40) and the noise (≤0.19). The number is **model-dependent**, which is the real lesson: making it a per-user setting is a phase-5 follow-up. `smoke-search` prints the corpus's best similarity next to the floor, so a mis-set floor is visible.

Proven by `npm run framework:resparkable:smoke-search` against a real database: 26 assertions over the pgvector SQL, the tsvector ranking, cross-user isolation (including the case where another user's row is the _better_ vector match), the sweep, the tombstone and the archive transaction. It runs with real embeddings when a provider is configured and with deterministic synthetic vectors when not — printing which, because a green run should never claim more than it proved.

**Phase 6a has landed** — the four write paths the capabilities need, built
first so that every capability has an API-accessible twin rather than a private
one: `POST /resparkable/capture` (idempotent on `externalId`), `GET /resparkable/snapshot`
(the whole brain in an LLM-shaped payload, eight queries flat), `POST
/resparkable/ideate` (framings on demand, over a wider similarity floor than the
sweep uses) and the `GET`/`POST /resparkable/reviews` pair. `POST /resparkable/links`
moved its logic into `services/links.ts` in the same pass, so
`resparkable_link_entities` inherits the endpoint checks and the server-pinned
provenance rather than reimplementing them.

**Phase 6b has landed** — the agent layer. Fourteen capabilities, five agents,
the shared `resparkable-core` profile and four seeds; the rules and the reasoning are
in [`agents.md`](./agents.md), and the three that matter most are:

1. **The owner is resolved before a subclass runs.** `ResparkableCapability` mints
   the `OwnerScope` from `CapabilityContext.userId` and hands it to `run()`, so a
   capability cannot express an unscoped read. That is stronger than a check per
   class, because the failure it guards against is not a wrong check but a
   fourteenth capability that never had one — asserted as a sweep over all
   fourteen rather than a case per class.
2. **The model can read the brain, write most of it, and influence none of the
   ranking.** `manualBoost` is `omit()`ed from every upsert schema (a type error,
   not a review note) and `resparkable_reprioritise` takes no arguments at all — not a
   weight, not a filter, not an id. It triggers the deterministic ranker; it
   cannot steer it.
3. **Bindings are the enforcement, not the prompts.** The triage prompt says
   "never create a project or a goal"; a model having a bad day ignores advice.
   The absent `resparkable_upsert_project` binding is what holds, because the chat
   handler advertises only what an agent has an enabled row for. `resparkable-judge`
   is bound to nothing at all, asserted at the seed level.

One thing that phase 7 makes load-bearing: **`AiMessage.provenance` is outside the
Resparkable erasure cascade**, so every capability's `redactProvenance` keeps
structure (ids, statuses, horizons, counts) and masks prose (titles, notes,
queries, a third party's name). An id resolves to nothing once the row is erased;
a title would survive inside the audit bundle for ever.

**Phase 6c has landed** — the way in. Three pieces, and the reasoning for each
is in [`agents.md`](./agents.md) §§10–12:

1. **The context block.** One `LOCKED CONTEXT` block per turn — today's date and
   timezone, goals longest-horizon-first, active projects with days since
   activity, the top five tasks with the scorer's word for why, load and area
   balance. The loader reads `request.userId` and **ignores `id`**, because
   `buildContext` caches on `type:id:userId` and a loader that trusted `id` would
   render one person's goals into another's prompt and then cache the answer.
   Capped twice — per-section rows, then a ~1200-token budget that truncates on
   whole lines, because half an id in a prompt is worse than no id.
2. **`POST /resparkable/chat/stream`.** Its own route because the consumer one drops
   `contextType`/`contextId` (exactly what the block travels on) and the admin
   one wants `withAdminAuth`. Both context fields pinned server-side; `agentSlug`
   checked against the chat allowlist, which is the only thing between a browser
   and `resparkable-triage` — `streamChat` does not gate on visibility.
3. **`/resparkable/chat`**, on Resparkable's own chat component. Sunrise's is pinned to
   the admin endpoint (ask #26), and most of what it carries — cost, token
   breakdowns, the tool-argument trace — is admin-only anyway. What it adds is a
   chip naming **which tools ran**, in plain terms: this agent can write, and one
   that quietly created three tasks while answering a question is the thing
   people stop trusting.

Cache invalidation lives in `recordResparkableEvent`, so no service can forget —
every mutation in the tier records an event. `reprioritiseTasks` is the one
exception and invalidates directly: it records no event, and it is precisely what
reorders the block's task list.

**Phase 7 has landed** — four workflows on per-user schedules, the connection
sweep as an app job, the morning briefing and `workStyle`, all created by
`ensureResparkableSchedules()`.

**Phase 8 has landed** — the lifecycle. One line decides its whole shape:
**nothing a human wrote is ever deleted by a clock.** Notes, tasks, projects,
goals and reviews auto-_archive_ and stop there, restorable for ever; only
derived and log data is removed. Archive and prune are separate helpers with
separate return fields rather than a mode flag, because the difference is the
product's core promise and should not be one careless edit away.

Three things it does that are invisible when they break:

1. **A `rejected` link is never pruned.** The sweep excludes any pair that
   already has a link row, so a rejected row _is_ the tombstone that stops the
   same suggestion returning every Sunday for ever. The rule matches
   `status: 'suggested'` positively — `NOT IN ['rejected']` would look identical
   and reintroduce an infinite nag loop weeks later, somewhere else entirely.
   §11 warns that someone will try to clean these up; the test asserts a rejected
   row survives a pass dated a century out.
2. **Bulk archiving drops the entity's vectors in the same transaction as the
   stamp**, exactly as the per-id path already did. A second path that forgot
   would degrade recall gradually as history grows — no error, no symptom.
3. **Every rule caps at 500 rows and reports `capped`.** A pass that stopped at
   its limit is otherwise indistinguishable from one that found everything, which
   is the same property the sweep's `cappedTypes` protects one level down.

Retention runs on the sweep job's rotation rather than the nightly workflow — a
correction to `plan.md` §11, which `install.md` §2.10 had already anticipated.
Nothing about it is a moment: no user cares whether a 400-day-old event goes at
02:00 or 14:00, only that it eventually does. Per-user cron rows would have bought
that nothing and cost a row each to create, correct after a DST change and delete
on erasure — the exact three problems phase 7 spent its schedule code on.

The other half is the **stale digest**, and it deliberately does not enforce:
obsolescence is a question, not a rule. Four dormancy queries, each asked
differently because a shared "quiet since `lastActivityAt`" would be wrong four
ways — a project needs the two-part test or a busy project whose own row is never
edited reads as abandoned; an entity needs the link check from both ends of the
polymorphic edge; a goal needs a target date, because old is not a defect in a
goal; an area is asked through time blocks and has no `lastActivityAt` to gain.
**Entities are never auto-archived whatever their window says** — a dormant client
is not a dead one — so the digest is the only thing that raises them at all.
`resparkable_get_stale_digest` is read-only and there is no still-live capability, so
the restraint is a binding rather than a prompt.

Next is **phase 7b**. **Phase 0b is done** — Resparkable landed
both seams itself on 2026-07-31, and the merge that brought them in also cleared
phase 6's one known blocker ([resparkable#462](https://github.com/human-centric-engineering/sunrise/issues/462):
boot-registered capabilities and context contributors were silently lost at
request time under Turbopack, which is exactly what `initResparkable()` does). Eleven
upstream asks landed in that window; see [`resparkable-asks.md`](./resparkable-asks.md) →
Landed for what each changed here.

Three deviations from `plan.md` stand:

- **§5's thirteen capabilities are fourteen.** `resparkable_promote_thought` was
  added because none of the thirteen could mark a thought as processed — a
  nightly triage run would have created tasks and left the inbox looking
  untouched, then re-processed the same notes the following night. Dropping a
  thought is still impossible from any agent, deliberately.

- §16.8b's entity assertion now targets **`GET /resparkable/entities/[id]/view`**. The
  generic `[id]` handler stays deliberately bare — threading `?include=` through
  `createItemHandlers` would push page-shaped concerns into the one factory that
  guarantees the isolation rules for twenty routes.

- **§15 row 7's six workflows are four**, plus the connection sweep as an app job.
  `resparkable-capture-intake` moved to phase 9: it triggers on
  `resparkable_capture_for_token`, a phase 9 capability, so seeding it now would seed a
  workflow whose entry point does not exist. See
  [`phase-7-plan.md`](./phase-7-plan.md) §6 for the other three phase 7 departures.

A fourth deviation — card aging measuring `updatedAt` rather than time-in-column —
was **closed** by `14b6b324`, which added `{ statusFrom, statusTo }` to the
`updated` event only when the status actually changed, and reads the newest per
card in one `DISTINCT ON`. Cards with no such event still fall back to "untouched
since", worded differently so the two are never confused.

---

## The vault (Release 3 — phase 15 and the zip half of 17)

Obsidian import and export, without a live sync engine. §14 says phase 15 is
independently shippable and worth doing even if Release 3 stops there; this is
that, plus the zip transport and the starter-vault generator from 17.

**What was built:** `lib/framework/resparkable/vault/*` — `layout.ts` (the folder set,
path safety, filenames), `markdown.ts` (frontmatter codec over `yaml@2`),
`frontmatter.ts` (per-type Zod schemas), `notes.ts` (encoders, decoders, the
project checkbox block), `zip.ts` (`fflate` plus the decompression caps),
`export.ts`, `import-plan.ts` (pure) and `import.ts` (the writes). Two routes, a
page at `/resparkable/vault`, and a nav entry.

**What was deliberately not built:** the `ResparkableVault*` tables, the three-way
merge base, the sync runner, scheduling, `secret-box`, and the git and
cloud-drive transports. Those are §14's Release 4, and none of them is needed to
answer "get my data out and put it back".

### Six decisions worth knowing before reading the code

1. **An export of an empty brain _is_ the starter vault.** §14 treats
   `generateStarterVault` as a separate generator running against any transport.
   It collapses further than that: every export already writes the folder
   skeleton, the README describing the frontmatter contract, a minimal
   `.obsidian/` and `.brain/manifest.json`, so a brand-new user's export opens in
   Obsidian as a working vault. One code path means there is no second thing to
   keep true.

2. **The importer's index is built from the exporter's own encoders.** Change
   detection compares the incoming file against _the file we would have written_,
   not against a second view of the same columns. That is what makes **export →
   re-import is a no-op** hold by construction rather than by two hand-maintained
   field lists that drift apart in six months. It is the first test in
   `import-plan.test.ts`.

3. **`changedKeys` is the single source of truth, references included.** The
   first cut counted a resolved reference as work, which made every round-tripped
   task report an update — every export declares `project:`, so every import
   "changed" it. A reference resolution turns a name into an id; it does not
   decide whether to write. `hasWork()` is the one predicate, used by both the
   plan counts and the apply gate.

4. **Two spellings of one value must hash alike.** Quoting is presentation in
   YAML and it changes the _type_ — `estimate-minutes: 30` is a number,
   `"30"` is a string — and any editor may requote frontmatter without asking.
   So every scalar is compared as a string, and the integer fields accept both
   spellings rather than rejecting the note (a schema failure rejects the whole
   file, which would cost the user the paragraph underneath).

5. **The checkbox block is what makes this a surface rather than an export.**
   Every project note carries `- [ ] Title ^bt-<id>` lines between sentinels, and
   ticking one changes the real task. Exactly two things are read back: the state,
   and the text before the block id. A checkbox with no `^bt-` id creates nothing
   — otherwise pasting a to-do list into a project note as a note-to-self puts
   forty tasks in your ranking.

6. **Import never deletes, and blanking is guarded.** A row absent from the
   archive is left alone; `deletePropagation` is Release 4's, with its own opt-in.
   The only shape data loss can take here is a file whose body has gone missing —
   a bad merge, a truncated sync, a half-written file — silently wiping a note's
   prose. That is refused by default and reported per path, which costs one
   checkbox on the rare occasion somebody meant it.

### The security property, restated

`resparkable-id` is a **claim, never an address**. It is resolved through an index
built from an owner-scoped read, so an id belonging to another user is simply
absent and the note becomes a new row — §16.7's single most important sync test,
asserted directly rather than left to the type system. The same rule covers the
`^bt-` block ids in a checkbox block: an id that is not one of yours is ignored.

A note with **no** `resparkable-id` — one you wrote in Obsidian rather than exported —
falls back to matching on **slug**, for areas, projects and entities only. Nothing
writes a new id back into your file, so without this the second import of a
hand-authored note would create a second row, the third a third. The fallback
resolves through `bySlug` on that same owner-scoped index, so it widens nothing:
another user's slug is as absent as their id. Tasks, goals and thoughts are
excluded deliberately — they have no per-owner-unique slug, and two of them may
legitimately share a title, so guessing would file somebody's work under the
wrong item and they would find out much later.

Everything else follows the tier's existing boundaries. The planner is pure, so
the whole matrix is a table test with no mocks. The apply step writes only
through `repo/*`, so cross-user writes are not expressible and `indexedHash` is
nulled by the repo's own update — embedding stays deferred to the tick's
backfill, which is the difference between a four-second import of 5,000 notes and
a timeout.

### Departures from §14, and why

- **`Reviews/` and `Documents/` are export-only**, as §14 specifies — but they
  are enumerated in `VAULT_EXPORT_ONLY_TYPES` and reported to the user as skipped
  rather than silently dropped. "Nothing happened to my reviews" and "the Reviews
  folder was ignored" are different messages and only one is trustworthy.
- **The `## Links` block is export-only too.** §14 has associative links round-trip
  in a sentineled section; a link carries a measured `strength` and a rationale
  the sweep wrote, and there is no sane reading of a hand-edited similarity score.
  What _does_ come back is any `[[wikilink]]` in free prose, as
  `ResparkableLink{kind:'mentions', origin:'vault', status:'proposed'}` — §14's own
  highest-leverage line, capped at 25 per note so a hub note does not bury the
  pairs the sweep found by measurement.
- **Frontmatter/body conflict resolution is not implemented, because there is no
  merge base.** §14's DB-wins-on-fields / vault-wins-on-body asymmetry needs
  `ResparkableVaultFile.syncedFrontmatter`, which is Release 4's table. For a manual
  import the honest rule is "the file you uploaded wins for the fields it
  declares, and you saw the diff first" — which is why the dry run is the default
  rather than a convenience.
- **`archived:` is written and never acted on.** §14 does not rule on it. Archiving
  deletes an item's embeddings and takes it out of the semantic layer, so reaching
  that from a text file a sync could rewrite is a destructive action reached by
  accident. It appears in no type's `WRITABLE_KEYS`, and a test asserts that for
  every type — along with `visibility`, so a frontmatter edit can never publish
  something.
- **A note that moved between type folders is refused, not retyped.** A task and a
  project are different tables; creating a copy under the new type while the
  original lives on is worse than doing nothing and saying so.
