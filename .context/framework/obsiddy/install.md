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

> **Status: phase 0.** Only the scaffold exists. The steps marked _(phase N)_
> are not installable yet — they're listed so the checklist grows in place
> rather than being reconstructed later. This file is updated by every phase.

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

| Copy                                                  | To                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------- |
| `lib/framework/obsiddy/**`                            | same path                                                                 |
| `lib/framework/eslint.config.mjs`                     | same path — **merge** if your project already runs another framework tier |
| `prisma/schema/framework-obsiddy.prisma`              | same path                                                                 |
| `prisma/seeds/framework-obsiddy/**`                   | same path _(phase 6)_                                                     |
| `.context/framework/obsiddy/**`                       | same path                                                                 |
| `app/(protected)/obsiddy/**`, `app/api/v1/obsiddy/**` | same paths _(phases 2, 5)_                                                |
| `components/obsiddy/**`                               | same path _(phase 5)_                                                     |

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

### 2.5 Drift probes — `lib/app/db-drift.ts` _(phase 1)_

```ts
export function registerAppDriftProbes(): void {
  registerObsiddyDriftProbes();
}
```

Six probes cover the objects Prisma cannot see: the hand-written
`ObsiddySpace → user` FK, the `vector(1536)` column, the HNSW index and the
BM25 index among them. Without these, a later `migrate dev` can silently drop
one — a dropped HNSW index degrades to a sequential scan with no error.

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

## 3. Migrate _(phase 1)_

```bash
npm run db:migrate:deploy    # applies the hand-edited Obsiddy migration
npm run db:drift-check       # MUST be green before you go further
npm run db:seed              # applies prisma/seeds/framework-obsiddy/* (phase 6)
```

The Obsiddy migration is **hand-edited**, not generated: it creates the pgvector
column, the HNSW and BM25 indexes and the satellite FK, none of which Prisma
emits on its own. Re-generating it will drop those objects.

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
