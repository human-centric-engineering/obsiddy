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

**Release 1, phases 0–2 complete** — the tier is wired, the data model exists, and every core type has an owner-scoped CRUD API. There is no UI, no search and no agent layer yet.

| Wired                                   | Where                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------- |
| Boot (dynamic import → `initLeafApp()`) | `lib/app/bootstrap.ts` → `lib/framework/obsiddy/index.ts`                   |
| Env schema                              | `lib/app/env.ts` merges `obsiddyEnvSchema` (currently empty)                |
| Lint boundary                           | `lib/app/eslint.config.mjs` spreads `lib/framework/eslint.config.mjs`       |
| Protected route                         | `/obsiddy` in `lib/app/protected-routes.ts`                                 |
| Drift probes                            | `lib/app/db-drift.ts` → `registerObsiddyDriftProbes()` (six, B1 + B3–B7)    |
| Schema                                  | 18 models in `prisma/schema/framework-obsiddy.prisma`                       |
| Migrations                              | `add_second_brain`, `obsiddy_space_cascade` — hand-edited, never regenerate |
| Repo layer                              | `lib/framework/obsiddy/repo/*` — `OwnerScope`, 7 entity repos               |
| Services                                | `lib/framework/obsiddy/services/*` — resources, slug, events, space         |
| API                                     | `app/api/v1/obsiddy/**` — 20 route files over 7 types                       |

## The isolation contract (D5)

Everything in the brain is an **owner query**. `OwnerScope` is a branded type minted only from a verified session id, every repo function takes one, and three boundaries keep it honest:

1. `repo/**` may not import `access/**` (cross-user resolution, Release 2).
2. Nothing in the tier except `repo/**` may import Prisma at all.
3. Every create/update/delete targets `{ id, userId }` together, so another user's id matches no row — **404, never 403**, because a 403 confirms the row exists.

Proven by `npm run framework:obsiddy:smoke-isolation` against a real database: 27 assertions covering cross-user reads, writes, archive, restore, delete, dedupe and the erasure cascade.

Next: **phase 3** (the priority engine — `manualBoost`, snooze presets, `/obsiddy/today`, `/obsiddy/inbox` and ETags, verified by a ~40-case table test on the pure scorer). **Phase 0b** (upstreaming two seams to Sunrise) is a separate PR against the template and is tracked in [`sunrise-asks.md`](./sunrise-asks.md).
