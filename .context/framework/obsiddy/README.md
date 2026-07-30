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

1. **Obsiddy touches zero Sunrise-owned files.** Every such edit is a merge conflict inflicted on every host project. Two seams need upstreaming to Sunrise before that holds (`lib/app/maintenance-tasks.ts`, `lib/app/protected-nav.ts`) — see the plan, phase 0b.
2. **Seeds number from `001` inside `prisma/seeds/framework-obsiddy/`.** The runner discovers seeds recursively and `SeedHistory` keys on the path relative to `prisma/seeds/`, so Obsiddy's numbering cannot collide with a host's own seeds.

## Contents

| File                                   | What it is                                                                                                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`plan.md`](./plan.md)                 | The full implementation plan — data model, migrations, API, agents, workflows, prioritisation, lifecycle, boards, sharing, Obsidian sync, phasing, verification, risks |
| [`install.md`](./install.md)           | How a host Sunrise project installs Obsiddy — tier directories, one-line seam registrations, env vars, migration, verification. Kept current by every phase            |
| [`sunrise-asks.md`](./sunrise-asks.md) | What Obsiddy needs from upstream Sunrise — missing seams, core files a fork is forced to edit, platform gaps. Every row also gets an issue on the Sunrise repo         |

`plan.md` is the working copy that travels with the code. It is not auto-synced with any copy held outside the repository.

## Status

**Release 1, phases 0–4 complete** — the tier is wired, the data model exists, every core type has an owner-scoped CRUD API, tasks are ranked by a deterministic scorer, and the brain is searchable by meaning. There is still no UI and no agent layer.

| Wired                                   | Where                                                                                          |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Boot (dynamic import → `initLeafApp()`) | `lib/app/bootstrap.ts` → `lib/framework/obsiddy/index.ts`                                      |
| Env schema                              | `lib/app/env.ts` merges `obsiddyEnvSchema` (currently empty)                                   |
| Lint boundary                           | `lib/app/eslint.config.mjs` spreads `lib/framework/eslint.config.mjs`                          |
| Protected route                         | `/obsiddy` in `lib/app/protected-routes.ts`                                                    |
| Rate-limit sub-caps                     | `lib/app/rate-limit.ts` → `registerObsiddyRateLimits()` (search, reindex, sweep, upload)       |
| Admin nav                               | `lib/app/admin-nav.ts` → `registerObsiddyAdminNav()`                                           |
| Drift probes                            | `lib/app/db-drift.ts` → `registerObsiddyDriftProbes()` (six, B1 + B3–B7)                       |
| Schema                                  | 19 models in `prisma/schema/framework-obsiddy.prisma`                                          |
| Migrations                              | `add_second_brain`, `obsiddy_space_cascade`, `obsiddy_document_originals` — never regenerate   |
| Repo layer                              | `lib/framework/obsiddy/repo/*` — `OwnerScope`, 13 modules                                      |
| Services                                | `lib/framework/obsiddy/services/*` — resources, slug, events, space, snooze, today, inbox      |
| Priority engine                         | `lib/framework/obsiddy/priority/*` — pure scorer, batched reprioritise pass                    |
| Semantic layer                          | `lib/framework/obsiddy/{embedding,search,documents}/*` — indexer, hybrid search, sweep, ingest |
| Zoned time                              | `lib/framework/obsiddy/time/zoned.ts` — every schedule resolves in the user's zone             |
| API                                     | `app/api/v1/obsiddy/**` — 37 route files, plus one admin pair                                  |
| Admin UI                                | `/admin/obsiddy/settings` — document handling and the upload ceiling                           |

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

Scores are refreshed on every task mutation. The full nightly pass arrives with the workflows in phase 7 — until then, a task whose score depends on something _else_ changing (a project going quiet, a week rolling over) keeps its last value until it is next touched.

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

Next: **phase 5** (the UI — layout, Today, Inbox, Projects, Goals, Entities, Documents, Connections, Graph). **Phase 0b** (upstreaming two seams to Sunrise) is a separate PR against the template and is tracked in [`sunrise-asks.md`](./sunrise-asks.md).
