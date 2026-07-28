# Installing Obsiddy into a Sunrise project

Obsiddy is a **framework-tier module**, not a fork you copy wholesale. Installing
it means dropping four self-contained directories into a Sunrise-based project
and adding a handful of one-line registrations to that project's own `lib/app/*`
seams.

The design constraint behind this file: **Obsiddy touches zero Sunrise-owned
files.** Every step below is either a new file inside a reserved tier, or one
line inside a file Sunrise ships empty for exactly this purpose. If a future
step ever needs you to edit a Sunrise-owned file, that is a bug in Obsiddy —
open an issue rather than making the edit, because you'd be re-making it on
every upgrade.

> **Status: phases 0–2.** The tier scaffold, the data model and the CRUD API
> exist — §§1–3 and 5 are real and installable today. Steps still marked
> _(phase N)_ are listed so the checklist grows in place rather than being
> reconstructed later. This file is updated by every phase.

---

## 0. Requirements

| Requirement                                                          | Why                                                                                      |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Sunrise ≥ 0.7.0                                                      | Needs the `lib/app/*` seam set (bootstrap, env, eslint, protected-routes, db-drift)      |
| PostgreSQL with `pgvector`                                           | Embeddings are a `vector(1536)` column with an HNSW index _(phase 1)_                    |
| An embedding model configured in the orchestration provider registry | Obsiddy reuses `embedText`/`embedBatch` rather than owning an embedding path _(phase 4)_ |

Obsiddy adds **no new npm dependencies** in Release 1 except `d3-force`
_(phase 5)_ and `@dnd-kit/core` + `@dnd-kit/sortable` _(phase 5b)_.

---

## 1. Copy the tier directories

All four live under paths Sunrise reserves and never writes to, so they merge
cleanly on upgrade:

| Copy                                     | To                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| `lib/framework/obsiddy/**`               | same path                                                                 |
| `lib/framework/eslint.config.mjs`        | same path — **merge** if your project already runs another framework tier |
| `prisma/schema/framework-obsiddy.prisma` | same path                                                                 |
| `prisma/seeds/framework-obsiddy/**`      | same path _(phase 6)_                                                     |
| `.context/framework/obsiddy/**`          | same path                                                                 |
| `app/api/v1/obsiddy/**`                  | same path — 20 route files, each 2 lines                                  |
| `app/(protected)/obsiddy/**`             | same path _(phase 5)_                                                     |
| `scripts/smoke/obsiddy-isolation.ts`     | same path, plus the `smoke:obsiddy-isolation` entry in `package.json`     |
| `components/obsiddy/**`                  | same path _(phase 5)_                                                     |

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

### 2.6 Capabilities — `lib/app/capabilities.ts` _(phase 6)_

### 2.7 Chat context — `lib/app/context-contributors.ts` _(phase 6)_

### 2.8 Maintenance tasks — `lib/app/maintenance-tasks.ts` _(phase 7)_

Requires the `registerAppMaintenanceTask` seam (Sunrise phase 0b). Until it
lands upstream, the connection sweep and retention pass need one line added to
`lib/orchestration/maintenance/run-tick.ts` — the single documented exception to
the zero-core-file rule, and a temporary one.

### 2.9 Nav — `lib/app/protected-nav.ts` _(phase 5)_

Requires the `protected-nav` seam (Sunrise phase 0b). Until it lands, add one
entry to `components/layouts/protected-nav.tsx` by hand.

### 2.10 Admin nav — `lib/app/admin-nav.ts` _(phase 7b)_

---

## 3. Migrate

```bash
npm run db:migrate:deploy    # applies both Obsiddy migrations
npm run db:drift-check       # MUST be green before you go further
npm run db:seed              # applies prisma/seeds/framework-obsiddy/* (phase 6)
```

Two migrations:

| Migration                              | What                                                                                                                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `20260728222816_add_second_brain`      | 18 `framework_obsiddy_*` tables plus six objects Prisma cannot model, grouped as **Group B** at the foot of the file (mirroring the Sunrise baseline's Group A convention)                                   |
| `20260728232937_obsiddy_space_cascade` | The D1 cascade: a real FK from every scoped table to `framework_obsiddy_space("userId") ON DELETE CASCADE`, so erasing a user removes the whole brain. Also deletes any rows already orphaned by its absence |

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

## 4. Optional host steps

- **`app/robots.ts`** — add `/s/` to the disallow list if you use public share
  links _(Release 2)_. Optional by design: per-page `robots` metadata and the
  `X-Robots-Tag` header ship with the share reader and are the stronger
  controls, since robots.txt is advisory and doesn't de-index.
- **External cron** — production has no in-process ticker. Without cron hitting
  the maintenance tick, every background feature (connection sweep, retention,
  briefings) silently never runs and looks broken. See
  `.context/orchestration/scheduling.md`.

---

## 5. Verify

```bash
npm run validate         # type-check + lint + format
npm run db:drift-check   # phase 1 onward
npm run test
```

**One Sunrise test will fail, and it's supposed to.**
`tests/unit/lib/app/defaults.test.ts` asserts every `lib/app/*` seam ships
empty — the vanilla contract. Filling the ESLint seam (§2.3) breaks the
`toEqual([])` assertion. Adjust that one assertion to your project's reality
rather than deleting the test: the rest of the file is still protecting you
against a stray registration in the seams you have _not_ filled. Obsiddy's own
copy asserts identity with the framework tier array, so a block added straight
to the leaf seam still fails.

Then, the check that actually proves portability:

```bash
git stash -u && rm -rf lib/framework    # then revert the env + eslint seam lines
npm run build                           # must still succeed
```

The app must build with the tier removed — that's what proves the boot import
is genuinely dynamic. The env (§2.2) and lint (§2.3) seams import the tier
statically by necessity, so back those two lines out as part of the test.

---

## 6. Extending Obsiddy

`lib/app/obsiddy.ts` _(phase 6)_ is Obsiddy-owned but **host-editable** — the
place to register extra capabilities on the Obsiddy agents, add board column
presets, contribute swimlane dimensions, extend the priority weights, or add
entity kinds. Reach for it before forking Obsiddy; if what you need isn't
exposed there, that's the gap worth reporting.
