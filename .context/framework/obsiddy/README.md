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

**Release 1, phases 0–3 complete** — the tier is wired, the data model exists, every core type has an owner-scoped CRUD API, and tasks are ranked by a deterministic scorer. There is no UI, no search and no agent layer yet.

| Wired                                   | Where                                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| Boot (dynamic import → `initLeafApp()`) | `lib/app/bootstrap.ts` → `lib/framework/obsiddy/index.ts`                                 |
| Env schema                              | `lib/app/env.ts` merges `obsiddyEnvSchema` (currently empty)                              |
| Lint boundary                           | `lib/app/eslint.config.mjs` spreads `lib/framework/eslint.config.mjs`                     |
| Protected route                         | `/obsiddy` in `lib/app/protected-routes.ts`                                               |
| Drift probes                            | `lib/app/db-drift.ts` → `registerObsiddyDriftProbes()` (six, B1 + B3–B7)                  |
| Schema                                  | 18 models in `prisma/schema/framework-obsiddy.prisma`                                     |
| Migrations                              | `add_second_brain`, `obsiddy_space_cascade` — hand-edited, never regenerate               |
| Repo layer                              | `lib/framework/obsiddy/repo/*` — `OwnerScope`, 9 entity repos                             |
| Services                                | `lib/framework/obsiddy/services/*` — resources, slug, events, space, snooze, today, inbox |
| Priority engine                         | `lib/framework/obsiddy/priority/*` — pure scorer, batched reprioritise pass               |
| Zoned time                              | `lib/framework/obsiddy/time/zoned.ts` — every schedule resolves in the user's zone        |
| API                                     | `app/api/v1/obsiddy/**` — 29 route files                                                  |

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

Next: **phase 4** (indexer, `searchObsiddy`, connection sweep, document ingestion). **Phase 0b** (upstreaming two seams to Sunrise) is a separate PR against the template and is tracked in [`sunrise-asks.md`](./sunrise-asks.md).
