# Installing Obsiddy into a Sunrise project

Obsiddy is a **framework-tier module**, not a fork you copy wholesale. Installing
it means dropping four self-contained directories into a Sunrise-based project
and adding a handful of one-line registrations to that project's own `lib/app/*`
seams.

The design constraint behind this file: **Obsiddy touches zero Sunrise-owned
files, with one unavoidable exception.** Every step below is either a new file
inside a reserved tier, or one line inside a file Sunrise ships empty for
exactly this purpose. The exception is a single namespaced `package.json` script
entry (§1) — npm has no include mechanism, so no seam can exist. If any _other_
step ever needs you to edit a Sunrise-owned file, that is a bug in Obsiddy —
open an issue rather than making the edit, because you'd be re-making it on
every upgrade.

> **Status: phases 0–6b.** The tier scaffold, the data model, the CRUD API, the
> priority engine, the semantic layer (search, indexing, connections, document
> ingestion), the UI (twelve surfaces including the kanban board) and the agent
> layer (thirteen capabilities, five agents, four seeds) exist — §§1–6 are real
> and installable today. Steps still marked _(phase N)_ are listed so the
> checklist grows in place rather than being reconstructed later. This file is
> updated by every phase.
>
> **Phase 0b is done, upstream.** Both seams Obsiddy needed landed in Sunrise on
> 2026-07-31 (#469, #473), so §2.10 and §2.11 are now one-line registrations
> rather than documented workarounds, and installing Obsiddy no longer asks you to
> edit a Sunrise-owned file at all.

---

## 0. Requirements

| Requirement                                                          | Why                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sunrise ≥ 0.7.0                                                      | Needs the `lib/app/*` seam set (bootstrap, env, eslint, protected-routes, db-drift)                                                                                                                                                          |
| PostgreSQL with `pgvector`                                           | Embeddings are a `vector(1536)` column with an HNSW index _(phase 1)_                                                                                                                                                                        |
| An embedding model configured in the orchestration provider registry | Obsiddy reuses `embedText`/`embedBatch` rather than owning an embedding path. **Without one, capture and CRUD work but nothing is searchable** — the indexer throws a clear "no embedding provider configured" rather than degrading quietly |

Obsiddy adds **no new npm dependencies** in Release 1 except `d3-force`
_(phase 5)_ and `@dnd-kit/core` + `@dnd-kit/sortable` _(phase 5b)_.

---

## 1. Copy the tier directories

Every one lives under a path Sunrise reserves and never writes to, so they
merge cleanly on upgrade:

| Copy                                     | To                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| `lib/framework/obsiddy/**`               | same path                                                                 |
| `lib/framework/eslint.config.mjs`        | same path — **merge** if your project already runs another framework tier |
| `prisma/schema/framework-obsiddy.prisma` | same path                                                                 |
| `prisma/seeds/framework-obsiddy/**`      | same path — four units: capabilities, profile, agents, bindings           |
| `.context/framework/obsiddy/**`          | same path                                                                 |
| `app/api/v1/obsiddy/**`                  | same path — 56 route files, most of them 2 lines                          |
| `app/api/v1/admin/obsiddy/**`            | same path — the instance-settings pair                                    |
| `app/admin/obsiddy/**`                   | same path — the settings page                                             |
| `app/(protected)/obsiddy/**`             | same path — 16 pages across twelve surfaces                               |
| `scripts/framework/obsiddy/**`           | same path — plus one `package.json` script line, below                    |
| `components/obsiddy/**`                  | same path — the surfaces, the board, and the admin settings form          |

**The `package.json` lines.** The smoke scripts need entries, and
`package.json` is the single file Obsiddy cannot avoid touching — npm has no
include mechanism. Add them as the **last** entries in `scripts`, after
`prepare`:

```jsonc
"framework:obsiddy:smoke-isolation": "tsx --env-file=.env.local scripts/framework/obsiddy/smoke-isolation.ts",
"framework:obsiddy:smoke-priority": "tsx --env-file=.env.local scripts/framework/obsiddy/smoke-priority.ts",
"framework:obsiddy:smoke-search": "tsx --env-file=.env.local scripts/framework/obsiddy/smoke-search.ts"
```

Namespaced, and deliberately not in the `smoke:*` block:
[`CUSTOMIZATION.md`](../../../CUSTOMIZATION.md) §7 reserves the unprefixed
script names — `smoke:*` among them — for the platform, so a fork entry there
conflicts the next time upstream adds a smoke script. §7 originally named only
the leaf tier's `app:*`, leaving a framework tier with nowhere legitimate to put
a script; that was ask #12 and Sunrise reserved `framework:<tier>:*` for it
(#483, landed 2026-07-31). Appending after `prepare` keeps the diff in a region
upstream never edits either way.

If your project already has a framework tier (`lib/framework/daybreak/`, say),
Obsiddy sits beside it as a sibling — nothing goes in `lib/framework/` itself
except the shared tier `eslint.config.mjs`, whose exported array you extend
rather than replace.

**Seed numbering:** Obsiddy's seeds number from `001` _inside_
`prisma/seeds/framework-obsiddy/`. The seed runner discovers seeds recursively
and `SeedHistory` keys on the path relative to `prisma/seeds/`, so
`framework-obsiddy/001-*` cannot collide with your own `001-*`. Digit-prefixed
core seeds also run before letter-prefixed subdirectories, so Obsiddy's seeds
land after yours. Do **not** renumber them against your project.

---

## 2. Register the seams

Each is one import plus one line in a file Sunrise ships empty. Nothing here
asks you to paste in a function body.

### 2.1 Boot — `lib/app/bootstrap.ts`

```ts
export async function initApp(): Promise<void> {
  const { initObsiddy } = await import('@/lib/framework/obsiddy');
  await initObsiddy();
}
```

**The dynamic `import()` is load-bearing.** A static `@/lib/framework/...`
specifier is resolved at `next build` and breaks the build of any project
without the folder. Keep it as written.

If your project has its own boot work, put it in `lib/app/leaf-bootstrap.ts` —
Obsiddy calls that after its own registrations, so yours can override them.

### 2.2 Environment — `lib/app/env.ts`

```ts
import { z } from 'zod';

import { obsiddyEnvSchema } from '@/lib/framework/obsiddy/env';

export const appEnvSchema = z.object({/* your own vars */}).merge(obsiddyEnvSchema);
```

Unlike the boot seam this import is necessarily **static** — `lib/env.ts` parses
the merged schema during a synchronous module load. Removing Obsiddy therefore
means removing this line as well as the tier folder.

Every Obsiddy variable is optional with a working default, so a fresh install
boots with none of them set:

| Variable                    | Default                                            | Phase |
| --------------------------- | -------------------------------------------------- | ----- |
| _(none yet)_                |                                                    |       |
| `OBSIDDY_INBOX_DOMAIN`      | unset — email capture off                          | 9     |
| `OBSIDDY_GIT_ALLOWED_HOSTS` | `github.com,gitlab.com,bitbucket.org,codeberg.org` | 19    |

### 2.3 Lint — `lib/app/eslint.config.mjs`

```js
import frameworkEslintConfig from '../framework/eslint.config.mjs';

export default [...frameworkEslintConfig /* , your own blocks after */];
```

Spread the framework tier **first** so your own leaf blocks still win for their
paths. Note flat config's `no-restricted-imports` **replaces rather than
merges** — any block of yours covering `lib/framework/**` must restate the base
`@/`-alias ban or relative-import enforcement silently dies there.

### 2.4 Protected routes — `lib/app/protected-routes.ts`

```ts
export const appProtectedRoutes: string[] = ['/obsiddy'];
```

Edge redirect-to-login only; per-resource authorisation stays in the route
handlers. Public share links live under `/s/*` and must **not** be listed
_(Release 2)_.

### 2.5 Drift probes — `lib/app/db-drift.ts`

```ts
import { registerObsiddyDriftProbes } from '@/lib/framework/obsiddy/db-drift';

export function registerAppDriftProbes(): void {
  registerObsiddyDriftProbes();
}
```

Six probes (B1, B3–B7) cover the Postgres objects Prisma cannot see: the
hand-written `framework_obsiddy_space → user` FK **with its `ON DELETE CASCADE`
asserted**, the HNSW vector index, two `GENERATED ALWAYS` tsvector columns and
their GIN indexes. Without them a later `migrate dev` can drop one silently — a
dropped HNSW index doesn't error, it just turns vector search into a sequential
scan whose only symptom is latency that grows with the corpus.

The `GENERATED` probes assert `is_generated = 'ALWAYS'`, not merely that the
column exists: a migration that recreated it as a plain `tsvector` would leave
a column that is never populated, so search would quietly return nothing for
every row written afterwards.

### 2.6 Rate limits — `lib/app/rate-limit.ts`

```ts
import { registerObsiddyRateLimits } from '@/lib/framework/obsiddy/rate-limit';

export function registerAppRateLimits(): void {
  registerObsiddyRateLimits();
}
```

Five per-flow sub-caps, on top of the 100/min section cap `/api/v1/**` already
inherits from `proxy.ts`. They exist because a single request on these paths is
expensive rather than cheap: `/search` embeds the query (one paid API call each),
`/reindex` and `/connections/sweep` start batch jobs, `/documents` parses an
upload, and `/ideate` makes a chat-completion call.

| Path                            | Cap     | Keyed on     |
| ------------------------------- | ------- | ------------ |
| `/api/v1/obsiddy/search`        | 30/min  | session user |
| `/api/v1/obsiddy/reindex`       | 5/hour  | session user |
| `/api/v1/obsiddy/connections/*` | 5/hour  | session user |
| `/api/v1/obsiddy/documents`     | 20/hour | session user |
| `/api/v1/obsiddy/ideate`        | 10/hour | session user |

`/ideate` is the tightest of the five because it is the only flow that buys
tokens per request — the shape it guards against is a UI bug or an agent loop
calling it in a cycle, where the bill rather than the load is the damage.

Static import, like §2.2 — this runs in the middleware bundle, where there is
nowhere to `await`. `registerRateLimitRule` throws at boot if a matcher could
shadow a Sunrise-protected surface, so a mistake here fails loudly rather than
quietly capping the platform's own routes.

### 2.7 Admin nav — `lib/app/admin-nav.ts`

```ts
import { registerObsiddyAdminNav } from '@/lib/framework/obsiddy/admin-nav';

export function initAppNav(): void {
  registerObsiddyAdminNav();
}
```

Adds an **Obsiddy** section with the instance-settings page (§4.1). Obsiddy's
registrar is client-safe by necessity — `components/admin/admin-sidebar.tsx`
reads the registry during render, so registration cannot be async and cannot
reach the database. Keep anything you add here to the same rule.

### 2.8 Capabilities — `lib/app/capabilities.ts` _(phase 6b)_

```ts
import { registerObsiddyCapabilities } from '@/lib/framework/obsiddy/capabilities';

export function initAppCapabilities(): void {
  registerObsiddyCapabilities();
}
```

Registers the thirteen agent tools. Static import, like §2.2 and §2.6: Sunrise
calls `initAppCapabilities()` from `registerBuiltInCapabilities()` **lazily, in
the server route-handler realm, immediately before the first dispatch** — not at
boot. There is nowhere to `await`, and the lazy call site is the fix for
[sunrise#462][462], where boot-registered capabilities were silently lost at
request time under Turbopack because the two realms hold separate module graphs.

Keep whatever you add here cheap and synchronous for the same reason: it runs on
the request path the first time an agent dispatches.

**Registration is not availability.** A registered handler still needs an active
`AiCapability` row and an `AiAgentCapability` binding before any agent can call
it — both arrive with the seeds in §3. Register without seeding and the
dispatcher refuses at `capability_inactive`, which is the correct failure: an
operator who turned a tool off has turned it off.

[462]: https://github.com/human-centric-engineering/sunrise/issues/462

### 2.9 Chat context — `lib/app/context-contributors.ts` _(phase 6c)_

### 2.10 Recurring jobs — `lib/app/jobs.ts` _(phase 7)_

The connection sweep and the retention pass register here, via the seam Sunrise
landed for [#469] on 2026-07-31:

```ts
import { registerAppJob } from '@/lib/orchestration/maintenance/app-jobs';

export function initAppJobs(): void {
  registerAppJob({ name: 'obsiddy:sweep', intervalMs: 60 * 60 * 1000, run: … });
}
```

Note it is `registerAppJob({ name, intervalMs, run })` and not the
`registerAppMaintenanceTask` name `plan.md` originally proposed — the plan named
a seam that did not exist yet, and the one that shipped is shaped slightly
differently.

**Read the semantics before relying on it.** `intervalMs` is a _minimum gap_, not
a schedule, and last-run times live in process memory — so a multi-instance
deployment runs each job roughly once per instance per interval, and a restart
re-arms everything. Write Obsiddy's sweeps idempotent (they already claim rows
with `SKIP LOCKED` and stamp `nextSyncAt` before working, which is what makes
that safe). A job still in flight is skipped rather than started twice; a throw
is contained and folded into the tick's summary.

[#469]: https://github.com/human-centric-engineering/sunrise/issues/469

### 2.11 Nav — `lib/app/protected-nav.ts` _(phase 5, **required now**)_

Sunrise landed the seam for [#473] on 2026-07-31. Obsiddy offers the item; the
host places it:

```ts
import { DEFAULT_PROTECTED_NAV } from '@/lib/protected-nav/types';
import { OBSIDDY_NAV_ITEM } from '@/lib/framework/obsiddy/protected-nav';

export const protectedNavItems = [
  DEFAULT_PROTECTED_NAV[0],
  OBSIDDY_NAV_ITEM,
  ...DEFAULT_PROTECTED_NAV.slice(1),
];
```

**The seam replaces the platform default wholesale**, so this spread is not
optional decoration — omit `DEFAULT_PROTECTED_NAV` and the host loses Profile,
Settings and Admin from its header. The trade-off you accept by spreading: the
platform list is pinned as it stood at your upgrade, so a link Sunrise adds later
needs a re-spread to appear.

Until this landed, installing Obsiddy meant hand-editing
`components/layouts/protected-nav.tsx` — the one Sunrise-owned file Obsiddy
touched. **It touches none now.**

#### Optional: land users on `/obsiddy` after login

`lib/app/auth-landing.ts` landed with the same issue and is the other half of the
problem: a nav link to a product users are never sent to is still a dead end.
Sunrise hardcoded `/dashboard` at a dozen decision sites — login, OAuth, signup,
invite acceptance, email verification, the admin "back to…" links, the error
pages, `proxy.ts` — and this seam resolves all of them at once.

```ts
export const appAuthLandingRoute = '/obsiddy';
export const appAuthLandingLabel = 'Obsiddy';
```

Set the label with the route: leaving it default sends users to `/obsiddy` behind
a button still saying "Dashboard". **Obsiddy does not set this for you**, and
deliberately: whether your product _is_ Obsiddy or merely contains it is your
call, not a framework tier's. This repo leaves it `null`.

[#473]: https://github.com/human-centric-engineering/sunrise/issues/473

### 2.12 The UI — files a host copies _(phase 5)_

Obsiddy's user-facing surfaces are tier-owned files under paths a host project
copies wholesale. None of them is a Sunrise file, and none needs registering:

| What          | Path                                                   |
| ------------- | ------------------------------------------------------ |
| Pages         | `app/(protected)/obsiddy/**`                           |
| API routes    | `app/api/v1/obsiddy/**`                                |
| Admin page    | `app/admin/obsiddy/**`                                 |
| Components    | `components/obsiddy/**`                                |
| Library       | `lib/framework/obsiddy/**`                             |
| Schema        | `prisma/schema/framework-obsiddy.prisma`               |
| Migrations    | `prisma/migrations/*obsiddy*` and `*add_second_brain*` |
| Docs          | `.context/framework/obsiddy/**`                        |
| Smoke scripts | `scripts/framework/obsiddy/**`                         |

### The removal list — verified, and longer than the table above

The portability claim is that **the app still builds with Obsiddy gone**, which is
what proves the tier is a guest rather than a dependency. Phase 0 stated that as
"delete `lib/framework/`"; that was true when the tier had no routes, and running
it in phase 5 showed it is now incomplete in two ways.

Deleting the tier-owned paths above is **not sufficient** — the build fails with
`Module not found`, because the seam files a host _added_ when installing still
import it. Uninstalling means undoing §2.1–§2.12, not just removing files:

| Revert                                              | What it registered                              |
| --------------------------------------------------- | ----------------------------------------------- |
| `lib/app/bootstrap.ts`, `lib/app/leaf-bootstrap.ts` | the boot hook                                   |
| `lib/app/env.ts`                                    | `obsiddyEnvSchema`                              |
| `lib/app/rate-limit.ts`                             | the four sub-caps                               |
| `lib/app/admin-nav.ts`                              | the admin section                               |
| `lib/app/db-drift.ts`                               | the six drift probes                            |
| `lib/app/protected-routes.ts`                       | `/obsiddy`                                      |
| `lib/app/protected-nav.ts`                          | the header link — back to `null` (§2.11)        |
| `lib/app/auth-landing.ts`                           | only if you set it — back to `null` (§2.11)     |
| `lib/app/jobs.ts`                                   | the sweep and retention jobs (phase 7, §2.10)   |
| `lib/app/eslint.config.mjs`                         | the tier lint boundary                          |
| `lib/framework/eslint.config.mjs`                   | (tier-owned; delete it)                         |
| `tests/unit/lib/app/defaults.test.ts`               | the pinned `SEAM_DEFAULTS` rows — back to empty |
| `app/api/v1/admin/obsiddy/**`                       | the admin settings pair                         |

**Verified 2026-07-30** against the pre-merge list (ten reverts, one of them the
`protected-nav.tsx` core-file line): with the table above deleted and those
reverted, `npm run build` compiles.

**Updated 2026-07-31, not re-verified.** The 2026-07-31 upstream merge moved the
nav entry off the core file and onto `lib/app/protected-nav.ts`, and added two
rows a host may have filled. The list is right by construction — every row is a
seam Obsiddy asks a host to fill in §2 — but the build has not been re-run
against it since. **Re-verify before relying on it**, and treat that as the CI
check risk 1b calls for rather than a one-off.

Two consequences worth stating: the check needs a clean `.next` (stale generated
route types reference deleted pages and produce misleading `tsc` errors), and a CI
version of this needs to script the seam reverts rather than a single `rm -rf`.

Three npm dependencies arrive with the UI:

```bash
npm install d3-force @dnd-kit/core @dnd-kit/sortable
npm install -D @types/d3-force
```

`d3-force` lays out the graph (`@xyflow/react` renders it but expects
coordinates); the two `@dnd-kit` packages drive the board and are the reason the
board is operable by keyboard at all.

---

## 3. Migrate

```bash
npm run db:migrate:deploy    # applies all six Obsiddy migrations
npm run db:drift-check       # MUST be green before you go further
npm run db:seed              # applies prisma/seeds/framework-obsiddy/*
```

The seed step is not optional once §2.8 is wired: the four units below are what
turn thirteen registered handlers into thirteen tools an agent can actually
reach. They are idempotent, keyed on slug, and re-runnable.

| Seed                     | Writes                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `001-capabilities`       | 13 `AiCapability` rows, written **from the code catalogue** so a row cannot drift from its handler              |
| `002-agent-profile`      | The `obsiddy-core` `AiAgentProfile` — the persona, guardrails and voice all five agents inherit                 |
| `003-agents`             | 5 `AiAgent` rows: companion, triage, connector, strategist, and the `kind: 'judge'` one a `judge_call` resolves |
| `004-agent-capabilities` | The bindings. This table is where "the triage agent must not create projects" stops being advice                |

**What re-seeding does and does not overwrite.** Prompts, descriptions and
function definitions are rewritten — they are code artefacts, and a stale
function definition silently steers the model toward a parameter that no longer
exists. Everything an operator legitimately tunes is left alone: `isActive`,
`rateLimit`, `requiresApproval`, `quarantineState`, `model`, `provider`,
`temperature`, `maxTokens`, and `AiAgentCapability.isEnabled`.

**To revoke a capability from an agent, set `isEnabled: false` — do not delete
the row.** A missing pivot row synthesizes a default-ALLOW binding in the
dispatcher, so the intuitive action is the one that widens access.

Three migrations:

| Migration                                   | What                                                                                                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `20260728222816_add_second_brain`           | 18 `framework_obsiddy_*` tables plus six objects Prisma cannot model, grouped as **Group B** at the foot of the file (mirroring the Sunrise baseline's Group A convention)                                   |
| `20260728232937_obsiddy_space_cascade`      | The D1 cascade: a real FK from every scoped table to `framework_obsiddy_space("userId") ON DELETE CASCADE`, so erasing a user removes the whole brain. Also deletes any rows already orphaned by its absence |
| `20260729212556_obsiddy_document_originals` | `framework_obsiddy_settings` (the instance-settings singleton, §4.1) and `framework_obsiddy_document.storageKey` made nullable, because originals are discarded by default                                   |

**It is hand-edited, and re-generating it will destroy things.** Two rules:

1. **Never regenerate this migration.** `prisma migrate dev --create-only`
   produced it; four statements were then deleted from the top, because Prisma
   reads the _Sunrise baseline's_ own unmodellable objects as drift and emits
   drops for them:

   ```sql
   DROP INDEX "idx_ai_knowledge_chunk_search_vector";   -- baseline A2
   DROP INDEX "idx_knowledge_embedding";                -- baseline A3
   DROP INDEX "idx_message_embedding";                  -- baseline A4
   ALTER TABLE "ai_knowledge_chunk" ALTER COLUMN "searchVector" DROP DEFAULT;
   ```

   Applying those degrades **Sunrise's own** knowledge and message search to
   sequential scans. This is not hypothetical: it happened upstream and went
   unnoticed for seven weeks.

2. **Inspect every future `migrate dev` in this project the same way.** Prisma
   re-emits drops for all of Group A _and_ Group B on every schema diff.
   `npm run db:drift-check` after each one is the backstop, and it is the reason
   the probes exist.

Requires PostgreSQL with `pgvector` — the migration's `CREATE EXTENSION IF NOT
EXISTS "vector"` is idempotent, so it succeeds whether or not the Sunrise
baseline already created it.

**Consequence of the cascade FK:** a brain row cannot exist without a space
row, so `ensureObsiddySpace(userId)` must run before a user's first write. Call
it at the top of any flow that could be someone's first interaction — first page
load, first capture, first agent turn. It is idempotent and race-safe.

---

## 4. Operator settings

### 4.1 Decide what happens to uploaded document originals

**`/admin/obsiddy/settings`.** Obsiddy parses every uploaded file, stores the
extracted text and embeds it; the original file is optional and **discarded by
default**.

That default is a security decision, not a frugal one: retaining a file is only
safe if the provider can hold it privately **and** hand it back, and not every
one can. Obsiddy asks the provider rather than recognising it by name — it reads
`getStorageCapabilities()`, where an undeclared capability means "cannot", so a
provider added later is refused until it says otherwise.

| Provider      | Retention                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `s3`          | Safe — **provided** ACLs are on or `S3_OBJECTS_PRIVATE_BY_DEFAULT=true`; without either it declares no private objects |
| `local`       | Safe since sunrise#490 — private root plus a signed read route. **Before that it published what it stored**            |
| `vercel-blob` | Unsupported — cannot store an object privately                                                                         |
| none          | Nothing to retain                                                                                                      |

The settings page names your resolved provider, explains what it can do, and
disables the retain option where it isn't safe — so this is a decision you can
make from the screen without reading this table.

**A capable provider makes retention possible, not advisable.** The default stays
`discard` on every provider: bytes you don't keep can't leak, and the extracted
text plus embedding chunks are what the product actually uses. The capability
check exists so that choosing `retain` is informed, not so that it becomes the
recommendation.

The same page carries the **upload ceiling** (default 25 MB). Sunrise ships two
contradictory caps — 5 MB global in `lib/validations/storage.ts` and 50 MB local
to the bulk knowledge route (ask #9) — so Obsiddy picks a middle default and
lets you change it rather than pretending the conflict doesn't exist.

Nothing is written to the database until you save, so a fresh install runs on the
defaults with no settings row at all.

## 5. Optional host steps

- **`app/robots.ts`** — add `/s/` to the disallow list if you use public share
  links _(Release 2)_. Optional by design: per-page `robots` metadata and the
  `X-Robots-Tag` header ship with the share reader and are the stronger
  controls, since robots.txt is advisory and doesn't de-index.
- **External cron** — production has no in-process ticker. Without cron hitting
  the maintenance tick, every background feature (connection sweep, retention,
  briefings) silently never runs and looks broken. See
  `.context/orchestration/scheduling.md`.

  Ranking degrades gracefully in the meantime rather than breaking: task scores
  are rewritten on every mutation, so anything the user touches is current. What
  a missing tick costs is the scores that move on their own — a project going
  quiet, a week rolling over, a `manualBoost` expiring — which stay stale until
  that task is next edited. The full nightly pass lands in phase 7.

---

## 6. Verify

```bash
npm run validate                            # type-check + lint + format
npm run db:drift-check                      # phase 1 onward
npm run test
npm run framework:obsiddy:smoke-isolation   # cross-user isolation + erasure cascade
npm run framework:obsiddy:smoke-priority    # ranking, snooze and the aggregates
npm run framework:obsiddy:smoke-search      # vectors, hybrid SQL, sweep, archive
```

**Run all three smoke scripts against a real database.** The unit suite mocks
Prisma at the module boundary, so it verifies the shape of every query and nothing
about whether Postgres accepts it. That gap has already cost one shipped bug:
the phase-2 migration added a foreign key from every scoped table to
`framework_obsiddy_space`, nothing called `ensureObsiddySpace()`, and every new
user's first write returned a 500 — under a completely green test suite. The
scripts skip cleanly (exit 0) when no database is reachable, and clean up after
themselves on every path.

`smoke-search` reports which mode it ran in. With an embedding provider
configured it exercises the whole stack, real vectors included. **Without one it
does not skip** — it seeds deterministic synthetic vectors through the real
insert path and still proves the pgvector SQL, the HNSW index, the tsvector
ranking, cross-user isolation, the connection sweep and the archive transaction.
What that mode cannot tell you is whether the embeddings are any _good_, so run it
once with a provider before trusting search quality.

**Four Sunrise tests will fail, and they're supposed to.** All assert that a
`lib/app/*` seam ships empty — the vanilla contract — so filling the seam, which
is the entire point of the seam, breaks them. This is upstream
[#480](https://github.com/human-centric-engineering/sunrise/issues/480); until it
lands, adjust the assertion rather than deleting the test, so the rest of each
file still protects you against a stray registration in the seams you have _not_
filled.

| Test                                                         | Broken by                                                       | Adjust to                                                           |
| ------------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------- |
| `tests/unit/lib/app/defaults.test.ts`                        | the ESLint (§2.3), rate-limit (§2.6) and admin-nav (§2.7) seams | the exact set each registrar owns                                   |
| `tests/unit/lib/db/drift-probes.test.ts`                     | the drift-probe scaffold (§2.5)                                 | identity with what `registerObsiddyDriftProbes()` alone registers   |
| `tests/unit/lib/app/bootstrap-wiring.test.ts`                | the rate-limit seam (§2.6)                                      | Obsiddy's rules reaching only `/api/v1/obsiddy/*`                   |
| `tests/unit/lib/orchestration/capabilities/registry.test.ts` | the capability seam (§2.8)                                      | stub the seam: `vi.mock('@/lib/app/capabilities')` — [ask #25][a25] |

[a25]: ./sunrise-asks.md

The fourth is worth calling out because its failure message points away from the
cause: the suite asserts `register` was called thirteen times, so a fork adding
its own capabilities sees "expected 13, got 26" reported as an **idempotency**
failure for a registry that was perfectly idempotent. Stubbing the seam makes the
test measure core, which is what it was always trying to measure.

Assert **identity with the thing your tier owns**, not a literal list — that way
a probe or block added straight to the leaf seam still fails, which is the
intent the original test was protecting. Obsiddy's own copies of both do this;
copy them.

Then, the check that actually proves portability:

```bash
git stash -u && rm -rf lib/framework    # then revert the four static-import seams
npm run build                           # must still succeed
```

The app must build with the tier removed — that's what proves the boot import
is genuinely dynamic. Four seams import the tier **statically** by necessity, so
back those lines out as part of the test:

| Seam                               | Why it cannot be dynamic                                               |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `lib/app/env.ts` (§2.2)            | `lib/env.ts` parses the merged schema during a synchronous module load |
| `lib/app/eslint.config.mjs` (§2.3) | Flat config is a static default export                                 |
| `lib/app/rate-limit.ts` (§2.6)     | Runs in the middleware bundle, where there is nowhere to `await`       |
| `lib/app/admin-nav.ts` (§2.7)      | The sidebar reads the registry during client render                    |
| `lib/app/capabilities.ts` (§2.8)   | Called synchronously on the request path, before the first dispatch    |

Only `bootstrap.ts` must stay dynamic, and that is the one
`tests/unit/lib/framework/obsiddy/scaffold.test.ts` asserts by reading the file's
own import statements.

---

## 7. Extending Obsiddy

`lib/app/obsiddy.ts` _(phase 6)_ is Obsiddy-owned but **host-editable** — the
place to register extra capabilities on the Obsiddy agents, add board column
presets, contribute swimlane dimensions, extend the priority weights, or add
entity kinds. Reach for it before forking Obsiddy; if what you need isn't
exposed there, that's the gap worth reporting.
