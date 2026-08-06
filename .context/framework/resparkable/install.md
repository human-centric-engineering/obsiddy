# Installing Resparkable into a Sunrise project

Resparkable is a **framework-tier module**, not a fork you copy wholesale. Installing
it means dropping four self-contained directories into a Resparkable-based project
and adding a handful of one-line registrations to that project's own `lib/app/*`
seams.

The design constraint behind this file: **Resparkable touches zero Sunrise-owned
files, with one unavoidable exception.** Every step below is either a new file
inside a reserved tier, or one line inside a file Resparkable ships empty for
exactly this purpose. The exception is a single namespaced `package.json` script
entry (§1) — npm has no include mechanism, so no seam can exist. If any _other_
step ever needs you to edit a Sunrise-owned file, that is a bug in Resparkable —
open an issue rather than making the edit, because you'd be re-making it on
every upgrade.

> **Status: phases 0–8.** The tier scaffold, the data model, the CRUD API, the
> priority engine, the semantic layer (search, indexing, connections, document
> ingestion), the UI (fourteen surfaces including the kanban board and chat),
> the agent layer (eighteen capabilities, six agents, five seeds, the per-turn
> context block and the app-owned chat route), the background (four scheduled
> workflows, the connection sweep as an app job, the morning briefing and the
> erasure hook) and the lifecycle (retention on the same rotation, the stale
> digest, the archive surface) exist — §§1–8 are real and installable today.
> Steps still marked _(phase N)_ are listed so the checklist grows in place
> rather than being reconstructed later. This file is updated by every phase.
>
> **Phase 0b is done, upstream.** Both seams Resparkable needed landed in Sunrise on
> 2026-07-31 (#469, #473), so §2.10 and §2.11 are now one-line registrations
> rather than documented workarounds, and installing Resparkable no longer asks you to
> edit a Resparkable-owned file at all.

---

## 0. Requirements

| Requirement                                                          | Why                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Resparkable ≥ 0.7.0                                                  | Needs the `lib/app/*` seam set (bootstrap, env, eslint, protected-routes, db-drift)                                                                                                                                                              |
| PostgreSQL with `pgvector`                                           | Embeddings are a `vector(1536)` column with an HNSW index _(phase 1)_                                                                                                                                                                            |
| An embedding model configured in the orchestration provider registry | Resparkable reuses `embedText`/`embedBatch` rather than owning an embedding path. **Without one, capture and CRUD work but nothing is searchable** — the indexer throws a clear "no embedding provider configured" rather than degrading quietly |

Resparkable adds **no new npm dependencies** in Release 1 except `d3-force`
_(phase 5)_ and `@dnd-kit/core` + `@dnd-kit/sortable` _(phase 5b)_.

Release 3 (Obsidian import/export) adds two more: **`yaml`** and **`fflate`**.
Both are commonly present transitively already; Resparkable declares them as direct
dependencies deliberately, because free-riding on another package's copy is one
`npm update` away from a build failure. `gray-matter` is deliberately _not_ used
— 40 lines over `yaml@2` gives control of BOM, CRLF and delimiter handling, and
`yaml@2` preserves formatting when rewriting frontmatter in a file somebody edits
by hand.

---

## 1. Copy the tier directories

Every one lives under a path Resparkable reserves and never writes to, so they
merge cleanly on upgrade:

| Copy                                         | To                                                                         |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| `lib/framework/resparkable/**`               | same path                                                                  |
| `lib/framework/eslint.config.mjs`            | same path — **merge** if your project already runs another framework tier  |
| `prisma/schema/framework-resparkable.prisma` | same path                                                                  |
| `prisma/seeds/framework-resparkable/**`      | same path — five units: capabilities, profile, agents, bindings, workflows |
| `.context/framework/resparkable/**`          | same path                                                                  |
| `app/api/v1/resparkable/**`                  | same path — 70 route files, most of them 2 lines                           |
| `app/api/v1/admin/resparkable/**`            | same path — the instance-settings pair                                     |
| `app/admin/resparkable/**`                   | same path — the settings page                                              |
| `app/(protected)/resparkable/**`             | same path — 19 pages across fifteen surfaces                               |
| `scripts/framework/resparkable/**`           | same path — plus one `package.json` script line, below                     |
| `components/resparkable/**`                  | same path — the surfaces, the board, and the admin settings form           |

**The `package.json` lines.** The smoke scripts need entries, and
`package.json` is the single file Resparkable cannot avoid touching — npm has no
include mechanism. Add them as the **last** entries in `scripts`, after
`prepare`:

```jsonc
"framework:resparkable:smoke-isolation": "tsx --env-file=.env.local scripts/framework/resparkable/smoke-isolation.ts",
"framework:resparkable:smoke-priority": "tsx --env-file=.env.local scripts/framework/resparkable/smoke-priority.ts",
"framework:resparkable:smoke-search": "tsx --env-file=.env.local scripts/framework/resparkable/smoke-search.ts"
```

Namespaced, and deliberately not in the `smoke:*` block:
[`CUSTOMIZATION.md`](../../../CUSTOMIZATION.md) §7 reserves the unprefixed
script names — `smoke:*` among them — for the platform, so a fork entry there
conflicts the next time upstream adds a smoke script. §7 originally named only
the leaf tier's `app:*`, leaving a framework tier with nowhere legitimate to put
a script; that was ask #12 and Resparkable reserved `framework:<tier>:*` for it
(#483, landed 2026-07-31). Appending after `prepare` keeps the diff in a region
upstream never edits either way.

If your project already has a framework tier (`lib/framework/daybreak/`, say),
Resparkable sits beside it as a sibling — nothing goes in `lib/framework/` itself
except the shared tier `eslint.config.mjs`, whose exported array you extend
rather than replace.

**Seed numbering:** Resparkable's seeds number from `001` _inside_
`prisma/seeds/framework-resparkable/`. The seed runner discovers seeds recursively
and `SeedHistory` keys on the path relative to `prisma/seeds/`, so
`framework-resparkable/001-*` cannot collide with your own `001-*`. Digit-prefixed
core seeds also run before letter-prefixed subdirectories, so Resparkable's seeds
land after yours. Do **not** renumber them against your project.

---

## 2. Register the seams

Each is one import plus one line in a file Resparkable ships empty. Nothing here
asks you to paste in a function body.

### 2.1 Boot — `lib/app/bootstrap.ts`

```ts
export async function initApp(): Promise<void> {
  const { initResparkable } = await import('@/lib/framework/resparkable');
  await initResparkable();
}
```

**The dynamic `import()` is load-bearing.** A static `@/lib/framework/...`
specifier is resolved at `next build` and breaks the build of any project
without the folder. Keep it as written.

If your project has its own boot work, put it in `lib/app/leaf-bootstrap.ts` —
Resparkable calls that after its own registrations, so yours can override them.

### 2.2 Environment — `lib/app/env.ts`

```ts
import { z } from 'zod';

import { resparkableEnvSchema } from '@/lib/framework/resparkable/env';

export const appEnvSchema = z.object({/* your own vars */}).merge(resparkableEnvSchema);
```

Unlike the boot seam this import is necessarily **static** — `lib/env.ts` parses
the merged schema during a synchronous module load. Removing Resparkable therefore
means removing this line as well as the tier folder.

Every Resparkable variable is optional with a working default, so a fresh install
boots with none of them set:

| Variable                        | Default                                            | Phase |
| ------------------------------- | -------------------------------------------------- | ----- |
| _(none yet)_                    |                                                    |       |
| `RESPARKABLE_INBOX_DOMAIN`      | unset — email capture off                          | 9     |
| `RESPARKABLE_GIT_ALLOWED_HOSTS` | `github.com,gitlab.com,bitbucket.org,codeberg.org` | 19    |

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
export const appProtectedRoutes: string[] = ['/resparkable'];
```

Edge redirect-to-login only; per-resource authorisation stays in the route
handlers. Public share links live under `/s/*` and must **not** be listed
_(Release 2)_.

### 2.5 Drift probes — `lib/app/db-drift.ts`

```ts
import { registerResparkableDriftProbes } from '@/lib/framework/resparkable/db-drift';

export function registerAppDriftProbes(): void {
  registerResparkableDriftProbes();
}
```

Six probes (B1, B3–B7) cover the Postgres objects Prisma cannot see: the
hand-written `framework_resparkable_space → user` FK **with its `ON DELETE CASCADE`
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
import { registerResparkableRateLimits } from '@/lib/framework/resparkable/rate-limit';

export function registerAppRateLimits(): void {
  registerResparkableRateLimits();
}
```

Eight per-flow sub-caps, on top of the 100/min section cap `/api/v1/**` already
inherits from `proxy.ts`. They exist because a single request on these paths is
expensive rather than cheap: `/search` embeds the query (one paid API call each),
`/reindex` and `/connections/sweep` start batch jobs, `/documents` parses an
upload, `/transcribe` ships audio to a paid speech-to-text provider, `/vault`
reads every table the brain has (and on import inflates and plans an archive),
`/ideate` makes a chat-completion call, and `/chat` holds an SSE connection open
for a multi-step tool loop.

| Path                                      | Cap     | Keyed on     |
| ----------------------------------------- | ------- | ------------ |
| `/api/v1/resparkable/search`              | 30/min  | session user |
| `/api/v1/resparkable/reindex`             | 5/hour  | session user |
| `/api/v1/resparkable/connections/sweep`   | 5/hour  | session user |
| `/api/v1/resparkable/documents/*`         | 20/hour | session user |
| `/api/v1/resparkable/transcribe`          | 10/min  | session user |
| `/api/v1/resparkable/vault/*`             | 10/hour | session user |
| `/api/v1/resparkable/ideate`              | 10/hour | session user |
| `/api/v1/resparkable/briefing/regenerate` | 10/hour | session user |
| `/api/v1/resparkable/chat/*`              | 20/min  | session user |

`/ideate` and `/briefing/regenerate` are the tightest per hour because they are
the flows that buy tokens per request — the shape they guard against is a UI bug
or an agent loop calling one in a cycle, where the bill rather than the load is
the damage. `/chat` and `/transcribe` are per-minute instead, because both are
genuinely interactive: an hourly cap generous enough for a real working session
would be no cap at all against a client that re-sends on every render.

The rule order in the table is the registration order, and
`tests/unit/lib/app/defaults.test.ts` asserts the exact set — a stray rule fails
there, and so does one that escapes the `/api/v1/resparkable/` namespace.

Static import, like §2.2 — this runs in the middleware bundle, where there is
nowhere to `await`. `registerRateLimitRule` throws at boot if a matcher could
shadow a Resparkable-protected surface, so a mistake here fails loudly rather than
quietly capping the platform's own routes.

### 2.7 Admin nav — `lib/app/admin-nav.ts`

```ts
import { registerResparkableAdminNav } from '@/lib/framework/resparkable/admin-nav';

export function initAppNav(): void {
  registerResparkableAdminNav();
}
```

Adds an **Resparkable** section with the instance-settings page (§4.1). Resparkable's
registrar is client-safe by necessity — `components/admin/admin-sidebar.tsx`
reads the registry during render, so registration cannot be async and cannot
reach the database. Keep anything you add here to the same rule.

### 2.8 Capabilities — `lib/app/capabilities.ts` _(phase 6b)_

```ts
import { registerResparkableCapabilities } from '@/lib/framework/resparkable/capabilities';

export function initAppCapabilities(): void {
  registerResparkableCapabilities();
}
```

Registers the eighteen agent tools. Static import, like §2.2 and §2.6: Resparkable
calls `initAppCapabilities()` from `registerBuiltInCapabilities()` **lazily, in
the server route-handler realm, immediately before the first dispatch**. There is
nowhere to `await`, and the lazy call site is the fix for [resparkable#462][462],
where boot-registered capabilities were silently lost at request time under
Turbopack because the two realms hold separate module graphs.

Keep whatever you add here cheap and synchronous for the same reason: it runs on
the request path the first time an agent dispatches.

**It also runs at boot, and you get that for free.** `initResparkable()` (§2.1)
calls `registerBuiltInCapabilities()` itself, so the registry is filled before
the first maintenance tick as well as before the first dispatch. That is not
belt-and-braces: `executors/tool-call.ts` is the one dispatch path that does
**not** ensure registration, so a scheduled workflow of `tool_call` steps firing
on a server that has served no chat, agent or MCP request would otherwise hit an
empty registry and fail every step with `unknown_capability` — at 03:15, where
nothing surfaces it. Since #462 made the registry `globalThis`-backed, a boot
registration is visible from the scheduler's realm, so the two call sites
compose rather than conflict. Nothing for a host to wire; noted because the
lazy-only story above was the whole story until Resparkable's background workflows
proved it wasn't. Tracked as [resparkable#537][537]; the boot call comes out when the
one-line core fix lands.

**Registration is not availability.** A registered handler still needs an active
`AiCapability` row and an `AiAgentCapability` binding before any agent can call
it — both arrive with the seeds in §3. Register without seeding and the
dispatcher refuses at `capability_inactive`, which is the correct failure: an
operator who turned a tool off has turned it off.

[462]: https://github.com/human-centric-engineering/sunrise/issues/462
[537]: https://github.com/human-centric-engineering/sunrise/issues/537

### 2.9 Chat context — `lib/app/context-contributors.ts`

```ts
import { registerResparkableContextContributor } from '@/lib/framework/resparkable/context';

export function initAppContextContributors(): void {
  registerResparkableContextContributor();
}
```

Registers the `resparkable` context type — the `LOCKED CONTEXT` block injected into
every turn of `/resparkable/chat`: today's date and timezone, the person's goals,
active projects with days since activity, top-ranked tasks, load and area
balance.

Static import, and for the same reason as §2.8: core calls
`initAppContextContributors()` lazily from `buildContext`, on the chat-turn hot
path, with nowhere to await.

**Core catches anything this throws** and degrades to "no app contributors"
rather than failing the turn. That is right for a chat surface and a trap for a
registrar: a mistake here has no symptom except an agent that has quietly stopped
knowing anything about the person. Keep whatever you add synchronous and
failure-free.

The contributor itself reads `request.userId` and **ignores the `id` argument**.
`buildContext` caches on `type:id:userId`, so a loader that trusted `id` would
render one person's goals into another person's prompt and then serve the cached
answer. If you write your own contributor for a different type, copy that rule.

### 2.10 Recurring jobs — `lib/app/jobs.ts` _(phase 7)_

The per-brain rotation registers here, via the seam Resparkable landed for [#469] on
2026-07-31. One import, one call, three passes: the connection sweep and the
schedule pass (phase 7), and retention (phase 8, as promised here).

```ts
import { registerResparkableJobs } from '@/lib/framework/resparkable/jobs';

export function initAppJobs(): void {
  registerResparkableJobs();
}
```

**Why these are jobs and the other four are schedules.** Resparkable's nightly
triage, morning briefing, weekly review and horizon check are calendar events —
"9am on the 2nd", "Friday at 16:00" — and live on per-user `AiWorkflowSchedule`
rows created by `ensureResparkableSchedules()`. The connection sweep is a continuous
per-user pass with its own rotation cursor, which a cron field expresses badly.

Retention is the same shape, and joined the rotation in phase 8 against a plan
that had put it in the nightly workflow. Nothing about it is a moment: no user
cares whether a 400-day-old event is deleted at 02:00 or 14:00, only that it
eventually is. `plan.md` §11 has been corrected to match.

**What retention will do to your data, stated plainly**, because this is the pass
that removes things. Notes, tasks, projects, goals and reviews **archive** — they
are hidden from every list, search and prompt, stay readable, and restore with one
click, for ever. Nothing a user wrote is ever deleted by a clock. Only derived and
log data is deleted: connection suggestions nobody looked at, the activity log
past its window, past planning blocks, and board cards pointing at archived tasks.
Windows are per-user, default to the §11 table, and are editable at
`/resparkable/settings` — seven of the eight are, at least. `staleEntityDays` is in the
policy but read by nothing and not rendered on the card: there is no entity
retention rule, because §11 says a person or company is never auto-archived, and a
control that changed nothing while its own row said "then deleted" was worse than
its absence. Entities are raised by the stale digest instead, whose windows are
constants. Every rule caps at 500 rows per brain per pass — including the
closed-project cascade, which archives its batch of tasks and leaves the projects
for the next rotation rather than stamping them over tasks it has not reached — so
a first run over an old corpus drains across several rotations rather than in one
tick.

**The sweep's rotation also carries the schedule pass**, and that is not
incidental. `ensureResparkableSchedules()` is idempotent and self-correcting, but
`ensureResparkableSpace` only calls it when a space is _created_ — so without a
second call site it never runs twice for anybody, and both corrections it exists
to make (a cron that no longer matches the user's UTC offset after a DST change;
an `inputTemplate` written by an older version, which fails its workflow on every
run) would be unreachable. Running it once per brain per rotation is what lets a
fix to schedule-writing reach rows that already exist — in your install, not just
the one where the bug was found. If you register these jobs, you get that; if you
skip `lib/app/jobs.ts` entirely, be aware that you are also skipping it.

Note it is `registerAppJob({ name, intervalMs, run })` and not the
`registerAppMaintenanceTask` name `plan.md` originally proposed — the plan named
a seam that did not exist yet, and the one that shipped is shaped slightly
differently.

**Read the semantics before relying on it.** `intervalMs` is a _minimum gap_, not
a schedule, and last-run times live in process memory — so a multi-instance
deployment runs each job roughly once per instance per interval, and a restart
re-arms everything. Write Resparkable's sweeps idempotent (they already claim rows
with `SKIP LOCKED` and stamp `nextSyncAt` before working, which is what makes
that safe). A job still in flight is skipped rather than started twice; a throw
is contained and folded into the tick's summary.

**The sweep also carries a cleanup that is not really a sweep.** It deletes
Resparkable schedules whose owner has been erased. That belongs to the erasure hook
(§2.13) and is duplicated here on purpose — see that section for why the hook
alone cannot be relied on.

[#469]: https://github.com/human-centric-engineering/sunrise/issues/469

### 2.11 Nav — `lib/app/protected-nav.ts` _(phase 5, **required now**)_

Sunrise landed the seam for [#473] on 2026-07-31. Resparkable offers the item; the
host places it:

```ts
import { DEFAULT_PROTECTED_NAV } from '@/lib/protected-nav/types';
import { RESPARKABLE_NAV_ITEM } from '@/lib/framework/resparkable/protected-nav';

export const protectedNavItems = [
  DEFAULT_PROTECTED_NAV[0],
  RESPARKABLE_NAV_ITEM,
  ...DEFAULT_PROTECTED_NAV.slice(1),
];
```

**The seam replaces the platform default wholesale**, so this spread is not
optional decoration — omit `DEFAULT_PROTECTED_NAV` and the host loses Profile,
Settings and Admin from its header. The trade-off you accept by spreading: the
platform list is pinned as it stood at your upgrade, so a link Resparkable adds later
needs a re-spread to appear.

Until this landed, installing Resparkable meant hand-editing
`components/layouts/protected-nav.tsx` — the one Sunrise-owned file Resparkable
touched. **It touches none now.**

#### Optional: land users on `/resparkable` after login

`lib/app/auth-landing.ts` landed with the same issue and is the other half of the
problem: a nav link to a product users are never sent to is still a dead end.
Resparkable hardcoded `/dashboard` at a dozen decision sites — login, OAuth, signup,
invite acceptance, email verification, the admin "back to…" links, the error
pages, `proxy.ts` — and this seam resolves all of them at once.

```ts
export const appAuthLandingRoute = '/resparkable';
export const appAuthLandingLabel = 'Resparkable';
```

Set the label with the route: leaving it default sends users to `/resparkable` behind
a button still saying "Dashboard". **Resparkable does not set this for you**, and
deliberately: whether your product _is_ Resparkable or merely contains it is your
call, not a framework tier's. This repo leaves it `null`.

[#473]: https://github.com/human-centric-engineering/sunrise/issues/473

### 2.12 The UI — files a host copies _(phase 5)_

Resparkable's user-facing surfaces are tier-owned files under paths a host project
copies wholesale. None of them is a Resparkable file, and none needs registering:

| What          | Path                                                       |
| ------------- | ---------------------------------------------------------- |
| Pages         | `app/(protected)/resparkable/**`                           |
| API routes    | `app/api/v1/resparkable/**`                                |
| Admin page    | `app/admin/resparkable/**`                                 |
| Components    | `components/resparkable/**`                                |
| Library       | `lib/framework/resparkable/**`                             |
| Schema        | `prisma/schema/framework-resparkable.prisma`               |
| Migrations    | `prisma/migrations/*resparkable*` and `*add_second_brain*` |
| Docs          | `.context/framework/resparkable/**`                        |
| Smoke scripts | `scripts/framework/resparkable/**`                         |

### 2.13 Erasure — automatic, but read this _(phase 7)_

Resparkable registers its own erasure cleanup hook from `initResparkable()`, so there is
**nothing to wire**. It is documented because of what it cleans up and why it
cannot be fully trusted.

> Its sibling, the **subject-access export** (Art. 15), **is not automatic** and
> must be wired by hand — see [§2.15](#215-subject-access-export--libappdata-exportts-required-resparkable--080).

Every `framework_resparkable_*` table hangs off `ResparkableSpace`, whose FK to `"user"`
is `ON DELETE CASCADE` — deleting the user deletes the brain, with no app code
involved. Phase 7 is the first time Resparkable writes to a table it does not own:
`AiWorkflowSchedule`, whose `createdBy` is **`onDelete: SetNull`**. Those rows
therefore outlive the account, enabled and with a live `nextRunAt`, unless
something deletes them.

**The hook that deletes them may not be registered when erasure runs.**
`registerErasureCleanupHook` writes into a plain module-scope `Map`, and
`eraseUser()` reads it without lazily initialising any `lib/app/*` seam first —
unlike capabilities, context contributors and jobs, each of which core
re-initialises in the consuming realm. That is the same instrumentation/route
module split as [resparkable#462], for a registry that was not in its sweep.

So the sweep job (§2.10) also deletes Resparkable schedules whose `createdBy` is
`null`. A null owner on an Resparkable schedule can only mean the FK was nulled by
the cascade, so it is an unambiguous tombstone. **Both paths are deliberate**: the
hook is correct and immediate when it fires, and the job catches the case where
it did not — including schedules orphaned before this code existed.

[resparkable#462]: https://github.com/human-centric-engineering/sunrise/issues/462

### 2.14 External cron — **required in production** _(phase 7)_

Everything in §2.10 — the schedules, the sweep, the briefing — is driven by one
endpoint being hit on a timer. Development gets that free from the in-process 60s
ticker in `instrumentation.ts`. **Production has no ticker at all.** Point an
external scheduler at the maintenance tick:

```
POST /api/v1/admin/orchestration/maintenance/tick
```

Every five minutes is a sensible default; the schedules resolve their own due
times, so the tick only has to be frequent enough that "9am" means 9am rather
than 9:55. See [`.context/orchestration/scheduling.md`](../../orchestration/scheduling.md)
for auth and the platform-specific recipes.

**This was an optional footnote until phase 7 and is not one now.** Before it,
nothing in Resparkable ran on its own, so a missing tick cost only ranking freshness.
After it, a host that skips this step gets an install where the morning briefing
never arrives, no connection is ever proposed, no nightly re-score happens and the
weekly review is silently absent — with no error anywhere, because nothing failed.
Nothing ran. It is the single most likely answer to "why did nothing happen".

Ranking itself still degrades gracefully: scores are rewritten on every mutation,
so anything the user touches is current. What a missing tick costs is the scores
that move on their own — a project going quiet, a week rolling over, a
`manualBoost` expiring — which stay stale until that task is next edited.

### The removal list — verified, and longer than the table above

The portability claim is that **the app still builds with Resparkable gone**, which is
what proves the tier is a guest rather than a dependency. Phase 0 stated that as
"delete `lib/framework/`"; that was true when the tier had no routes, and running
it in phase 5 showed it is now incomplete in two ways.

Deleting the tier-owned paths above is **not sufficient** — the build fails with
`Module not found`, because the seam files a host _added_ when installing still
import it. Uninstalling means undoing §2.1–§2.12, not just removing files:

| Revert                                              | What it registered                              |
| --------------------------------------------------- | ----------------------------------------------- |
| `lib/app/bootstrap.ts`, `lib/app/leaf-bootstrap.ts` | the boot hook                                   |
| `lib/app/env.ts`                                    | `resparkableEnvSchema`                          |
| `lib/app/rate-limit.ts`                             | the eight sub-caps                              |
| `lib/app/admin-nav.ts`                              | the admin section                               |
| `lib/app/db-drift.ts`                               | the six drift probes                            |
| `lib/app/protected-routes.ts`                       | `/resparkable`                                  |
| `lib/app/protected-nav.ts`                          | the header link — back to `null` (§2.11)        |
| `lib/app/auth-landing.ts`                           | only if you set it — back to `null` (§2.11)     |
| `lib/app/jobs.ts`                                   | the sweep and retention jobs (phase 7, §2.10)   |
| `lib/app/data-export.ts`                            | the subject-access collector (§2.15)            |
| `lib/app/eslint.config.mjs`                         | the tier lint boundary                          |
| `lib/framework/eslint.config.mjs`                   | (tier-owned; delete it)                         |
| `tests/unit/lib/app/defaults.test.ts`               | the pinned `SEAM_DEFAULTS` rows — back to empty |
| `app/api/v1/admin/resparkable/**`                   | the admin settings pair                         |

**Verified 2026-07-30** against the pre-merge list (ten reverts, one of them the
`protected-nav.tsx` core-file line): with the table above deleted and those
reverted, `npm run build` compiles.

**Updated 2026-07-31, not re-verified.** The 2026-07-31 upstream merge moved the
nav entry off the core file and onto `lib/app/protected-nav.ts`, and added two
rows a host may have filled. The list is right by construction — every row is a
seam Resparkable asks a host to fill in §2 — but the build has not been re-run
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

### 2.15 Subject-access export — `lib/app/data-export.ts` _(**required**, Resparkable ≥ 0.8.0)_

The sibling of §2.13's erasure hook, and the half that is **not** automatic.
Sunrise 0.8.0 added the seam ([#467]); Resparkable supplies the collector, the host
wires it:

```ts
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { collectResparkableSubjectData } from '@/lib/framework/resparkable/repo/subject-export';

export async function collectAppSubjectData(subject: AppSubjectQuery): Promise<AppSubjectData> {
  return { resparkable: await collectResparkableSubjectData(ownerScope(subject.userId)) };
}
```

**Nest it under one key rather than spreading it.** Resparkable owns seventeen
sections and can add an eighteenth in a later release; spreading them into the
top level means a host's own app section can be silently overwritten by a name
Resparkable adds later.

**Skipping this is a compliance decision, not a convenience one.** Erasure
(Art. 17) works with no wiring because the FK cascade does it; access (Art. 15)
does not, and an unwired seam returns `{}` — an export bundle that looks
complete and omits the subject's entire brain. Nothing warns you: no error, no
empty-looking response, just a shorter file. If you deliberately do not want the
tier in your export, say so in a comment where this function is, so the omission
reads as a decision.

What Resparkable exports, and the two deliberate holes — `ResparkableSpace.inboxToken`
(a live bearer secret) and `ResparkableEmbedding` (derived vectors over text already
exported in full) — is documented in `repo/subject-export.ts`, with a guard test
that fails the build if a new table is added to the schema and not to the
manifest.

**One local patch is required until [#533] lands.** Core's own coverage guard
(`tests/unit/lib/privacy/export-sources.test.ts`) scans every file in
`prisma/schema/`, including `framework-resparkable.prisma`, but builds its
`declared` set from the core-owned `SUBJECT_DATA_SOURCES` alone — so filling the
seam correctly still leaves the test red. Add the tier's eighteen models to that
file's `HANDLED_OUTSIDE_MANIFEST` with a reason; see ask #30 in
[`resparkable-asks.md`](./resparkable-asks.md).

[#467]: https://github.com/human-centric-engineering/sunrise/issues/467
[#533]: https://github.com/human-centric-engineering/sunrise/issues/533

---

## 3. Migrate

```bash
npm run db:migrate:deploy    # applies all six Resparkable migrations
npm run db:drift-check       # MUST be green before you go further
npm run db:seed              # applies prisma/seeds/framework-resparkable/*
```

The seed step is not optional once §2.8 is wired: the four units below are what
turn fourteen registered handlers into fourteen tools an agent can actually
reach. They are idempotent, keyed on slug, and re-runnable.

| Seed                     | Writes                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `001-capabilities`       | 14 `AiCapability` rows, written **from the code catalogue** so a row cannot drift from its handler              |
| `002-agent-profile`      | The `resparkable-core` `AiAgentProfile` — the persona, guardrails and voice all five agents inherit             |
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

`001-capabilities` and `004-agent-capabilities` declare
`hashInputs: ['…/capabilities/catalogue.ts']`. The seed runner hashes a unit's
own source to decide whether to re-run it, and those two files barely change —
the capability definitions all live in the catalogue. Without it, upgrading
Resparkable gets you a new tool's _code_ and no new row, and the dispatcher then
refuses it at `capability_inactive`. Keep the declaration if you fork either
file.

Three migrations:

| Migration                                       | What                                                                                                                                                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20260728222816_add_second_brain`               | 18 `framework_resparkable_*` tables plus six objects Prisma cannot model, grouped as **Group B** at the foot of the file (mirroring the Sunrise baseline's Group A convention)                                   |
| `20260728232937_resparkable_space_cascade`      | The D1 cascade: a real FK from every scoped table to `framework_resparkable_space("userId") ON DELETE CASCADE`, so erasing a user removes the whole brain. Also deletes any rows already orphaned by its absence |
| `20260729212556_resparkable_document_originals` | `framework_resparkable_settings` (the instance-settings singleton, §4.1) and `framework_resparkable_document.storageKey` made nullable, because originals are discarded by default                               |

**It is hand-edited, and re-generating it will destroy things.** Two rules:

1. **Never regenerate this migration.** `prisma migrate dev --create-only`
   produced it; four statements were then deleted from the top, because Prisma
   reads the _Resparkable baseline's_ own unmodellable objects as drift and emits
   drops for them:

   ```sql
   DROP INDEX "idx_ai_knowledge_chunk_search_vector";   -- baseline A2
   DROP INDEX "idx_knowledge_embedding";                -- baseline A3
   DROP INDEX "idx_message_embedding";                  -- baseline A4
   ALTER TABLE "ai_knowledge_chunk" ALTER COLUMN "searchVector" DROP DEFAULT;
   ```

   Applying those degrades **Resparkable's own** knowledge and message search to
   sequential scans. This is not hypothetical: it happened upstream and went
   unnoticed for seven weeks.

2. **Inspect every future `migrate dev` in this project the same way.** Prisma
   re-emits drops for all of Group A _and_ Group B on every schema diff.
   `npm run db:drift-check` after each one is the backstop, and it is the reason
   the probes exist.

Requires PostgreSQL with `pgvector` — the migration's `CREATE EXTENSION IF NOT
EXISTS "vector"` is idempotent, so it succeeds whether or not the Resparkable
baseline already created it.

**Consequence of the cascade FK:** a brain row cannot exist without a space
row, so `ensureResparkableSpace(userId)` must run before a user's first write. Call
it at the top of any flow that could be someone's first interaction — first page
load, first capture, first agent turn. It is idempotent and race-safe.

---

## 4. Operator settings

### 4.1 Decide what happens to uploaded document originals

**`/admin/resparkable/settings`.** Resparkable parses every uploaded file, stores the
extracted text and embeds it; the original file is optional and **discarded by
default**.

That default is a security decision, not a frugal one: retaining a file is only
safe if the provider can hold it privately **and** hand it back, and not every
one can. Resparkable asks the provider rather than recognising it by name — it reads
`getStorageCapabilities()`, where an undeclared capability means "cannot", so a
provider added later is refused until it says otherwise.

| Provider      | Retention                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `s3`          | Safe — **provided** ACLs are on or `S3_OBJECTS_PRIVATE_BY_DEFAULT=true`; without either it declares no private objects |
| `local`       | Safe since resparkable#490 — private root plus a signed read route. **Before that it published what it stored**        |
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

The same page carries the **upload ceiling** (default 25 MB). Resparkable ships two
contradictory caps — 5 MB global in `lib/validations/storage.ts` and 50 MB local
to the bulk knowledge route (ask #9) — so Resparkable picks a middle default and
lets you change it rather than pretending the conflict doesn't exist.

Nothing is written to the database until you save, so a fresh install runs on the
defaults with no settings row at all.

### 4.2 Reach the brain from Claude Code — MCP _(phase 7b)_

Optional, and the highest value-per-effort thing in the install. Resparkable seeds
eight `McpExposedTool` rows and three `McpExposedPrompt` rows; the rest is core's
MCP server, which is **off by default**.

1. `/admin/orchestration/mcp/settings` → enable the server.
2. `/admin/orchestration/mcp/keys` → create a key with `tools:list`,
   `tools:execute`, `prompts:read`. The `smcp_…` plaintext is shown **once**.
   **Mint it as the person whose brain it is** — `CapabilityContext.userId`
   comes from the key's creator, and that is the only thing deciding which brain
   the key reaches.
3. Point a client at it:

   ```bash
   claude mcp add --transport http resparkable https://your-host/api/v1/mcp \
     --header "Authorization: Bearer smcp_..."
   ```

**Read [`mcp.md`](./mcp.md) before assuming `scopedAgentId` restricts a key.** It
does not: tool scoping is default-allow, Resparkable's bindings work by absence, and
every enabled tool is callable by every key. The seeded list — seven reads plus
`resparkable_capture` — is the access control, and nothing that creates structure is
on it.

Both lists are cached for five minutes on a running server. Re-seed then
restart, or wait.

### 4.3 Two-second capture from a phone — iOS Shortcut _(phase 7b)_

Also optional, and it needs nothing seeded. `POST /api/v1/resparkable/capture` is
already reachable with a personal API key, because `withAuth` accepts one.

1. Mint a personal key. Resparkable ships the self-service routes but **no UI page**
   for them, so from the browser console of a logged-in session (same origin, so
   the cookie goes with it):

   ```js
   await (
     await fetch('/api/v1/user/api-keys', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ name: 'iPhone capture', scopes: ['chat'] }),
     })
   ).json();
   ```

   The `sk_…` value comes back **once**. Add `expiresAt` (ISO 8601) while you
   are there.

2. In the Shortcuts app: **Get Contents of URL** →
   `https://your-host/api/v1/resparkable/capture`, method `POST`, headers
   `Authorization: Bearer sk_…` and `Content-Type: application/json`, JSON body
   `{ "content": <Shortcut Input>, "source": "shortcut" }`.
3. Add it to the share sheet, the Lock Screen or a Back Tap. iOS queues it when
   offline.

Send an `externalId` too if you can generate a stable one — capture is
idempotent on it, so a double-tapped button returns the first row instead of
filing the thought twice.

> **The key is wider than the job.** `AiApiKey.scopes` is a closed enum in a
> Resparkable-owned file (`chat`, `analytics`, `knowledge`, `webhook`, `admin`), so
> the narrow `resparkable` scope this wants cannot be created — ask #34 in
> [`resparkable-asks.md`](./resparkable-asks.md) →
> [resparkable#542](https://github.com/human-centric-engineering/sunrise/issues/542).
> Use `chat`, and know that the key on
> your phone reaches every authenticated route as you, not just capture. Nothing
> about capture is weakened — the key resolves to its owner and `OwnerScope`
> confines every write to that one brain — but give it an `expiresAt`, and
> revoke it if the phone goes missing.

### 4.4 Know when triage gets worse _(phase 7b)_

`npm run framework:resparkable:eval-triage` runs thirty hand-classified thoughts
through the real triage agent and scores it deterministically. Take the number
before a prompt edit or a model swap, and again after. See
[`evaluations.md`](./evaluations.md) — including why it is a script rather than
a batch run in the admin UI, and what that protects you from.

## 5. Optional host steps

- **`app/robots.ts`** — add `/s/` to the disallow list if you use public share
  links _(Release 2)_. Optional by design: per-page `robots` metadata and the
  `X-Robots-Tag` header ship with the share reader and are the stronger
  controls, since robots.txt is advisory and doesn't de-index.
- **External cron** — moved to §2.14 and **no longer optional**. Phase 7 put the
  briefing, the schedules and the sweep behind the maintenance tick, so an install
  without cron is an install where the background half of Resparkable does not exist.

---

## 6. Verify

```bash
npm run validate                            # type-check + lint + format
npm run db:drift-check                      # phase 1 onward
npm run test
npm run framework:resparkable:smoke-isolation   # cross-user isolation + erasure cascade
npm run framework:resparkable:smoke-priority    # ranking, snooze and the aggregates
npm run framework:resparkable:smoke-search      # vectors, hybrid SQL, sweep, archive
```

**Run all three smoke scripts against a real database.** The unit suite mocks
Prisma at the module boundary, so it verifies the shape of every query and nothing
about whether Postgres accepts it. That gap has already cost one shipped bug:
the phase-2 migration added a foreign key from every scoped table to
`framework_resparkable_space`, nothing called `ensureResparkableSpace()`, and every new
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

**Four Resparkable tests will fail, and they're supposed to.** All assert that a
`lib/app/*` seam ships empty — the vanilla contract — so filling the seam, which
is the entire point of the seam, breaks them. This is upstream
[#480](https://github.com/human-centric-engineering/sunrise/issues/480); until it
lands, adjust the assertion rather than deleting the test, so the rest of each
file still protects you against a stray registration in the seams you have _not_
filled.

| Test                                                         | Broken by                                                       | Adjust to                                                             |
| ------------------------------------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------- |
| `tests/unit/lib/app/defaults.test.ts`                        | the ESLint (§2.3), rate-limit (§2.6) and admin-nav (§2.7) seams | the exact set each registrar owns                                     |
| `tests/unit/lib/db/drift-probes.test.ts`                     | the drift-probe scaffold (§2.5)                                 | identity with what `registerResparkableDriftProbes()` alone registers |
| `tests/unit/lib/app/bootstrap-wiring.test.ts`                | the rate-limit seam (§2.6)                                      | Resparkable's rules reaching only `/api/v1/resparkable/*`             |
| `tests/unit/lib/orchestration/capabilities/registry.test.ts` | the capability seam (§2.8)                                      | stub the seam: `vi.mock('@/lib/app/capabilities')` — [ask #25][a25]   |

[a25]: https://github.com/human-centric-engineering/sunrise/issues/525

The fourth is worth calling out because its failure message points away from the
cause: the suite asserts `register` was called thirteen times, so a fork adding
its own capabilities sees "expected 13, got 26" reported as an **idempotency**
failure for a registry that was perfectly idempotent. Stubbing the seam makes the
test measure core, which is what it was always trying to measure.

Assert **identity with the thing your tier owns**, not a literal list — that way
a probe or block added straight to the leaf seam still fails, which is the
intent the original test was protecting. Resparkable's own copies of both do this;
copy them.

**Then prove the background actually runs** (phase 7). Nothing above touches it:
the unit suite asserts the workflows are seeded and the schedules are computed,
which is not the same as a tick firing them.

1. Sign in once as a new user — `ensureResparkableSpace()` creates the space and
   `ensureResparkableSchedules()` writes four `AiWorkflowSchedule` rows against it.
2. Temporarily set one of them to `* * * * *` and let the tick run (or `POST` to
   `/api/v1/admin/orchestration/maintenance/tick` yourself). An execution should
   appear under `/admin/orchestration/executions` within the minute.
3. Press **Regenerate** on Today's briefing card, then press it again inside the
   staleness window. **The second press must make no LLM call** — check
   `/admin/orchestration/costs` or the provider's own dashboard. A briefing that
   silently regenerates on every press is indistinguishable from a working one
   until the invoice arrives, which is why this is a manual step rather than a
   line in a test file.

Then, the check that actually proves portability:

```bash
git stash -u && rm -rf lib/framework    # then revert the four static-import seams
npm run build                           # must still succeed
```

The app must build with the tier removed — that's what proves the boot import
is genuinely dynamic. Four seams import the tier **statically** by necessity, so
back those lines out as part of the test:

| Seam                                     | Why it cannot be dynamic                                               |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| `lib/app/env.ts` (§2.2)                  | `lib/env.ts` parses the merged schema during a synchronous module load |
| `lib/app/eslint.config.mjs` (§2.3)       | Flat config is a static default export                                 |
| `lib/app/rate-limit.ts` (§2.6)           | Runs in the middleware bundle, where there is nowhere to `await`       |
| `lib/app/admin-nav.ts` (§2.7)            | The sidebar reads the registry during client render                    |
| `lib/app/capabilities.ts` (§2.8)         | Called synchronously on the request path, before the first dispatch    |
| `lib/app/context-contributors.ts` (§2.9) | Called synchronously from `buildContext` on the chat-turn hot path     |

Only `bootstrap.ts` must stay dynamic, and that is the one
`tests/unit/lib/framework/resparkable/scaffold.test.ts` asserts by reading the file's
own import statements.

---

## 7. Extending Resparkable

**`lib/app/resparkable.ts` does not exist yet.** `plan.md` §2 specifies it — an
Resparkable-owned but host-editable file where a project registers extra
capabilities on the Resparkable agents, adds board column presets, contributes
swimlane dimensions, extends the priority weights or adds entity kinds — and
this section previously described it as though phase 6 had delivered it. It did
not, and nothing imports it. Said plainly here because a host project that goes
looking for the file is the person the error costs.

Until it lands, a host extends Resparkable through Sunrise's own seams rather than
an Resparkable-specific one: `lib/app/capabilities.ts` registers a capability, and
binding it to an Resparkable agent is a seed-level row (see §2.8). The tier's own
tables and services are not extensible from outside without editing
`lib/framework/resparkable/**`, which is the fork this seam exists to prevent — so
if you need a tweak that neither route reaches, that is the gap worth
reporting, and it is worth reporting loudly.
