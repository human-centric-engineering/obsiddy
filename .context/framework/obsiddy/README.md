# Obsiddy — framework-tier docs

Obsiddy is a **framework-tier module**: a reusable layer between Sunrise and the leaf forks that install it. Sunrise reserves this tier (`CUSTOMIZATION.md` § "Two reserved fork tiers") and never writes to it, so Sunrise upgrades merge cleanly underneath.

## Where Obsiddy's things live

| Concern    | Path                                                  |
| ---------- | ----------------------------------------------------- |
| Code       | `lib/framework/obsiddy/**`                            |
| Schema     | `prisma/schema/framework-obsiddy.prisma`              |
| Tables     | `framework_obsiddy_*`                                 |
| Seeds      | `prisma/seeds/framework-obsiddy/001-*.ts` onward      |
| Docs       | `.context/framework/obsiddy/**` (this folder)         |
| Routes     | `app/(protected)/obsiddy/**`, `app/api/v1/obsiddy/**` |
| Components | `components/obsiddy/**`                               |

Namespaced _inside_ the tier, never at its root — so a project already running another framework layer can add Obsiddy as a sibling rather than colliding.

## The two rules

1. **Obsiddy touches zero Sunrise-owned files** — as of the 2026-07-31 upstream merge, this is literally true rather than aspirational. Every such edit is a merge conflict inflicted on every host project. The two seams that were missing landed upstream: `lib/app/jobs.ts` + `registerAppJob` ([sunrise#469](https://github.com/human-centric-engineering/sunrise/issues/469)) and `lib/app/protected-nav.ts` ([sunrise#473](https://github.com/human-centric-engineering/sunrise/issues/473)). Neither carries the name `plan.md` proposed for it.
2. **Seeds number from `001` inside `prisma/seeds/framework-obsiddy/`.** The runner discovers seeds recursively and `SeedHistory` keys on the path relative to `prisma/seeds/`, so Obsiddy's numbering cannot collide with a host's own seeds.

## Contents

| File                                   | What it is                                                                                                                                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`plan.md`](./plan.md)                 | The full implementation plan — data model, migrations, API, agents, workflows, prioritisation, lifecycle, boards, sharing, Obsidian sync, **Cross-Pollination (§18)**, phasing, verification, risks |
| [`install.md`](./install.md)           | How a host Sunrise project installs Obsiddy — tier directories, one-line seam registrations, env vars, migration, verification. Kept current by every phase                                         |
| [`ui.md`](./ui.md)                     | The UI's rules and why each exists — one fetch per surface, read/mutate split, wire-shape parsing, the fork-owned primitives, and the checklist for adding a surface                                |
| [`agents.md`](./agents.md)             | The agent layer's rules — one truth for four places, the owner-scope guard, what an agent deliberately cannot do, the redaction line, the five agents, and why bindings are the enforcement         |
| [`sunrise-asks.md`](./sunrise-asks.md) | What Obsiddy needs from upstream Sunrise — missing seams, core files a fork is forced to edit, platform gaps. Every row also gets an issue on the Sunrise repo                                      |

`plan.md` is the working copy that travels with the code. It is not auto-synced with any copy held outside the repository.

## Status

**Release 1, phases 0–7 complete** — the tier is wired, the data model exists, every core type has an owner-scoped CRUD API, tasks are ranked by a deterministic scorer, the brain is searchable by meaning, there is a UI (thirteen surfaces at `/obsiddy`, including a kanban board), and **you can now talk to it**: fourteen capabilities, five agents, the shared profile they inherit, a per-turn context block that means the agent already knows your goals, and a chat page at `/obsiddy/chat`. Phase 7 added the background: four workflows on per-user schedules, the
connection sweep as an app job, the morning briefing, and the tier's first
erasure hook. Next is phase 7b — MCP exposure, the iOS Shortcut and the eval
dataset.

| Wired                                   | Where                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Boot (dynamic import → `initLeafApp()`) | `lib/app/bootstrap.ts` → `lib/framework/obsiddy/index.ts`                                                                                                                                                                                                                                                                                 |
| Env schema                              | `lib/app/env.ts` merges `obsiddyEnvSchema` (currently empty)                                                                                                                                                                                                                                                                              |
| Lint boundary                           | `lib/app/eslint.config.mjs` spreads `lib/framework/eslint.config.mjs`                                                                                                                                                                                                                                                                     |
| Protected route                         | `/obsiddy` in `lib/app/protected-routes.ts`                                                                                                                                                                                                                                                                                               |
| Rate-limit sub-caps                     | `lib/app/rate-limit.ts` → `registerObsiddyRateLimits()` (search, reindex, sweep, upload, ideate, chat, briefing regenerate — seven)                                                                                                                                                                                                       |
| Admin nav                               | `lib/app/admin-nav.ts` → `registerObsiddyAdminNav()`                                                                                                                                                                                                                                                                                      |
| Drift probes                            | `lib/app/db-drift.ts` → `registerObsiddyDriftProbes()` (six, B1 + B3–B7)                                                                                                                                                                                                                                                                  |
| Protected nav                           | `lib/app/protected-nav.ts` spreads `OBSIDDY_NAV_ITEM` — was a core-file edit until sunrise#473 landed 2026-07-31                                                                                                                                                                                                                          |
| App jobs                                | `lib/app/jobs.ts` → `registerObsiddyJobs()` (the connection sweep, phase 7)                                                                                                                                                                                                                                                               |
| Erasure hook                            | `initObsiddy()` → `registerObsiddyErasure()` — the tier's first, because phase 7 is the first time it writes to a table outside the cascade                                                                                                                                                                                               |
| Workflows                               | `prisma/seeds/framework-obsiddy/005-workflows.ts` — four, on per-user schedules from `ensureObsiddySchedules()`                                                                                                                                                                                                                           |
| Schema                                  | 19 models in `prisma/schema/framework-obsiddy.prisma`                                                                                                                                                                                                                                                                                     |
| Migrations                              | `add_second_brain`, `obsiddy_space_cascade`, `obsiddy_document_originals`, `obsiddy_sweep_cursor`, `obsiddy_document_hash_unique`, `obsiddy_connection_floor`, `obsiddy_space_sweep_cursor` — all hand-edited, never regenerate                                                                                                           |
| Repo layer                              | `lib/framework/obsiddy/repo/*` — `OwnerScope`, 24 modules                                                                                                                                                                                                                                                                                 |
| Capabilities                            | `lib/app/capabilities.ts` → `registerObsiddyCapabilities()` (seventeen; fourteen in 6b, three in phase 7)                                                                                                                                                                                                                                 |
| Services                                | `lib/framework/obsiddy/services/*` — resources, slug, events, space, snooze, today, inbox, promote, details, graph, connections-view, board-view, board-export, fractional-position, counts, link-hydration, **capture, snapshot, ideate, reviews, links** (phase 6a), **neighbours** (6b), **briefing, briefing-facts, recent-wins** (7) |
| Agent layer                             | `lib/framework/obsiddy/capabilities/*` — catalogue, scope guard, seventeen handlers; seeds in `prisma/seeds/framework-obsiddy/001–005`                                                                                                                                                                                                    |
| Priority engine                         | `lib/framework/obsiddy/priority/*` — pure scorer, batched reprioritise pass                                                                                                                                                                                                                                                               |
| Semantic layer                          | `lib/framework/obsiddy/{embedding,search,documents}/*` — indexer, hybrid search, sweep, ingest                                                                                                                                                                                                                                            |
| Zoned time                              | `lib/framework/obsiddy/time/zoned.ts` — every schedule resolves in the user's zone                                                                                                                                                                                                                                                        |
| UI contracts                            | `lib/framework/obsiddy/ui/*` — `OBSIDDY_ROUTES`, wire-shape schemas, the one server-read helper                                                                                                                                                                                                                                           |
| API                                     | `app/api/v1/obsiddy/**` — 64 route files, plus one admin pair (`GET`/`PATCH` on `admin/obsiddy/settings`)                                                                                                                                                                                                                                 |
| User UI                                 | `app/(protected)/obsiddy/**` — 13 surfaces; components in `components/obsiddy/**`                                                                                                                                                                                                                                                         |
| Admin UI                                | `/admin/obsiddy/settings` — document handling and the upload ceiling                                                                                                                                                                                                                                                                      |

## The UI, and the rules it follows (phase 5)

Thirteen surfaces under `app/(protected)/obsiddy/`: Today, Inbox, **Chat**,
Search, Projects (+ detail), Goals, Areas, People (+ detail), Documents,
Connections, Graph, Boards (+ board), Plan, Settings.

Four rules shape all of them, and each exists because breaking it is invisible:

1. **One enriched fetch per surface, never one per row.** `/today`, `/inbox`,
   `/connections`, `/graph`, and the four `/view` endpoints each assemble a page in a
   bounded number of queries. The route tests assert the query _count_, because an
   N+1 regression changes nothing you can see — it just quietly becomes thirty
   requests.
2. **Server components read; client components mutate.** A page fetches through
   `readObsiddy` and hands the payload to a `'use client'` child. Pages read through
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

Proven by `npm run framework:obsiddy:smoke-isolation` against a real database: 27 assertions covering cross-user reads, writes, archive, restore, delete, dedupe and the erasure cascade.

## How ranking works (D3)

`priorityScore` is **written, not computed per request**. A pure function over six weighted factors plus an additive `manualBoost` produces the number; every list endpoint is then one indexed `ORDER BY` with zero per-request work. An LLM chooses among the top few and writes rationales — it never produces a number that lands in the column.

Three properties the tests hold, because each is invisible when it breaks:

1. **`manualBoost` is applied additively after the weighted sum**, never as a seventh weighted term. That is what makes `+1` provably outrank every unboosted task, and it only holds while `base` stays inside `[0, 1]` — which is why the weights must sum to 1 and are normalised defensively on read.
2. **An expired boost reads as `0` at evaluation time**, never lazily zeroed by a background job. A pin set in March and forgotten stops applying the moment it expires, whether or not anything has run since.
3. **Every scheduling phrase resolves in `ObsiddySpace.timezone`.** "Tomorrow at 9am" from the web, a phone and an agent must mean one instant, and a day is 23 or 25 hours long twice a year.

Scores are refreshed on every task mutation, and phase 7's nightly triage adds the full pass — so a task whose score depends on something _else_ changing (a project going quiet, a week rolling over) is now re-scored overnight rather than waiting to be touched.

## How search works (D2, D4)

**One vector table, one re-embed path.** `ObsiddyEmbedding` holds every embedded type (`thought | project | goal | area | entity | document`), so there is a single `vector(1536)` column to drift-probe instead of six. `task` is deliberately absent — task titles are short and semantically thin, so they are searched through a generated tsvector (probe B4) instead.

**Search is exact, not approximate — the HNSW index is not on the query path.** Verified with `EXPLAIN` (2000 rows, `enable_seqscan = off`): the hybrid query plans as an index scan on `(userId, entityType)` plus a sort. pgvector's HNSW index only serves a bare `ORDER BY embedding <=> $1 LIMIT n`, and the two things that make this query useful — the distance pre-filter and the _blended_ ranking — both defeat it. That is the right trade at personal scale (exact distance over one user's few thousand chunks is perfect recall for a few milliseconds, where ANN would approximate for no gain), but it means the index currently protects a future rather than a present. Restructuring the query to use it changes recall semantics and is therefore a decision for a later phase, not a tidy-up.

Six properties, each invisible when it breaks:

1. **All vector SQL lives in `repo/embeddings.ts`.** The plan put `searchObsiddy` in `search/`, but the tier lint boundary forbids Prisma outside `repo/**` — and that constraint is worth more than the file layout, because it means the raw SQL, the one place a `WHERE "userId"` can be forgotten, can only be written in the layer whose every function takes an `OwnerScope`. `search/*` orchestrates; it cannot query.
2. **`indexedHash` is nulled liberally; the hash comparison is the cost gate.** Every update, restore and manual reindex nulls it — which queues a _comparison_, not an API call. (This was the design from the start and, until a review caught it, no `update*` path actually did it: edited notes kept their old vectors and old search snippets permanently. The repos now force `indexedHash: null` on every update, which is why the claim is finally true.) The indexer computes the canonical hash, checks it against what is stored, and only then spends anything. That is what lets a mutation path null the column without knowing which fields are semantic, and what keeps a corpus of five thousand notes from re-embedding because a status changed (§17 risk 3). `indexer.test.ts` asserts the call count on the embedder, both ways round.
3. **Archiving deletes the embedding rows in the same transaction as the archive.** An archived item left in the index behind a `WHERE archivedAt IS NULL` filter would make recall degrade silently as history grows — no error, no symptom (§17 risk 5b). The consequence is that the archived corpus has _no vectors at all_, so `?includeArchived=true` is served by a keyword pass instead. That is a deliberate trade, not a gap.
4. **The connection sweep costs nothing per run.** It reads _already-stored_ vectors and finds neighbour pairs in SQL (D4), so proactive connection-hunting can be left on forever; an LLM writes rationales later, only for pairs that cleared the similarity floor. Pair exclusion — including the `rejected` tombstone, in **both** directions — happens in the query, so no caller can forget it and re-nag someone every Sunday (§17 risk 5c).
5. **The sweep's per-type cap rotates.** Candidates are ordered by `sweptAt` (nulls first) and every examined id is stamped, so a capped run resumes where the last one stopped. The obvious ordering — most-recently-embedded — would have re-examined the same 200 rows for ever, leaving a 900-project corpus 78% unreachable while the log claimed it had merely stopped early.
6. **The similarity floor is 0.55, measured rather than assumed.** The plan specified 0.72; against the default embedding model (`text-embedding-3-small`) that sits _above_ the signal — the flagship "same idea, different words" pair scores 0.679, so the engine proposed nothing at all, silently and for ever. 0.55 admits it and still rejects the loosely-related (0.31–0.40) and the noise (≤0.19). The number is **model-dependent**, which is the real lesson: making it a per-user setting is a phase-5 follow-up. `smoke-search` prints the corpus's best similarity next to the floor, so a mis-set floor is visible.

Proven by `npm run framework:obsiddy:smoke-search` against a real database: 26 assertions over the pgvector SQL, the tsvector ranking, cross-user isolation (including the case where another user's row is the _better_ vector match), the sweep, the tombstone and the archive transaction. It runs with real embeddings when a provider is configured and with deterministic synthetic vectors when not — printing which, because a green run should never claim more than it proved.

**Phase 6a has landed** — the four write paths the capabilities need, built
first so that every capability has an API-accessible twin rather than a private
one: `POST /obsiddy/capture` (idempotent on `externalId`), `GET /obsiddy/snapshot`
(the whole brain in an LLM-shaped payload, eight queries flat), `POST
/obsiddy/ideate` (framings on demand, over a wider similarity floor than the
sweep uses) and the `GET`/`POST /obsiddy/reviews` pair. `POST /obsiddy/links`
moved its logic into `services/links.ts` in the same pass, so
`obsiddy_link_entities` inherits the endpoint checks and the server-pinned
provenance rather than reimplementing them.

**Phase 6b has landed** — the agent layer. Fourteen capabilities, five agents,
the shared `obsiddy-core` profile and four seeds; the rules and the reasoning are
in [`agents.md`](./agents.md), and the three that matter most are:

1. **The owner is resolved before a subclass runs.** `ObsiddyCapability` mints
   the `OwnerScope` from `CapabilityContext.userId` and hands it to `run()`, so a
   capability cannot express an unscoped read. That is stronger than a check per
   class, because the failure it guards against is not a wrong check but a
   fourteenth capability that never had one — asserted as a sweep over all
   fourteen rather than a case per class.
2. **The model can read the brain, write most of it, and influence none of the
   ranking.** `manualBoost` is `omit()`ed from every upsert schema (a type error,
   not a review note) and `obsiddy_reprioritise` takes no arguments at all — not a
   weight, not a filter, not an id. It triggers the deterministic ranker; it
   cannot steer it.
3. **Bindings are the enforcement, not the prompts.** The triage prompt says
   "never create a project or a goal"; a model having a bad day ignores advice.
   The absent `obsiddy_upsert_project` binding is what holds, because the chat
   handler advertises only what an agent has an enabled row for. `obsiddy-judge`
   is bound to nothing at all, asserted at the seed level.

One thing that phase 7 makes load-bearing: **`AiMessage.provenance` is outside the
Obsiddy erasure cascade**, so every capability's `redactProvenance` keeps
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
2. **`POST /obsiddy/chat/stream`.** Its own route because the consumer one drops
   `contextType`/`contextId` (exactly what the block travels on) and the admin
   one wants `withAdminAuth`. Both context fields pinned server-side; `agentSlug`
   checked against the chat allowlist, which is the only thing between a browser
   and `obsiddy-triage` — `streamChat` does not gate on visibility.
3. **`/obsiddy/chat`**, on Obsiddy's own chat component. Sunrise's is pinned to
   the admin endpoint (ask #26), and most of what it carries — cost, token
   breakdowns, the tool-argument trace — is admin-only anyway. What it adds is a
   chip naming **which tools ran**, in plain terms: this agent can write, and one
   that quietly created three tasks while answering a question is the thing
   people stop trusting.

Cache invalidation lives in `recordObsiddyEvent`, so no service can forget —
every mutation in the tier records an event. `reprioritiseTasks` is the one
exception and invalidates directly: it records no event, and it is precisely what
reorders the block's task list.

**Phase 7 has landed** — four workflows on per-user schedules, the connection
sweep as an app job, the morning briefing and `workStyle`, all created by
`ensureObsiddySchedules()`. Next is **phase 7b**. **Phase 0b is done** — Sunrise landed
both seams itself on 2026-07-31, and the merge that brought them in also cleared
phase 6's one known blocker ([sunrise#462](https://github.com/human-centric-engineering/sunrise/issues/462):
boot-registered capabilities and context contributors were silently lost at
request time under Turbopack, which is exactly what `initObsiddy()` does). Eleven
upstream asks landed in that window; see [`sunrise-asks.md`](./sunrise-asks.md) →
Landed for what each changed here.

Three deviations from `plan.md` stand:

- **§5's thirteen capabilities are fourteen.** `obsiddy_promote_thought` was
  added because none of the thirteen could mark a thought as processed — a
  nightly triage run would have created tasks and left the inbox looking
  untouched, then re-processed the same notes the following night. Dropping a
  thought is still impossible from any agent, deliberately.

- §16.8b's entity assertion now targets **`GET /obsiddy/entities/[id]/view`**. The
  generic `[id]` handler stays deliberately bare — threading `?include=` through
  `createItemHandlers` would push page-shaped concerns into the one factory that
  guarantees the isolation rules for twenty routes.

- **§15 row 7's six workflows are four**, plus the connection sweep as an app job.
  `obsiddy-capture-intake` moved to phase 9: it triggers on
  `obsiddy_capture_for_token`, a phase 9 capability, so seeding it now would seed a
  workflow whose entry point does not exist. See
  [`phase-7-plan.md`](./phase-7-plan.md) §6 for the other three phase 7 departures.

A fourth deviation — card aging measuring `updatedAt` rather than time-in-column —
was **closed** by `14b6b324`, which added `{ statusFrom, statusTo }` to the
`updated` event only when the status actually changed, and reads the newest per
card in one `DISTINCT ON`. Cards with no such event still fall back to "untouched
since", worded differently so the two are never confused.
