# Obsiddy — framework-tier docs

Obsiddy is a **framework-tier module**: a reusable layer between Sunrise and the leaf forks that install it. Sunrise reserves this tier (`CUSTOMIZATION.md` § "Two reserved fork tiers") and never writes to it, so Sunrise upgrades merge cleanly underneath.

## Where Obsiddy's things live

| Concern | Path |
| --- | --- |
| Code | `lib/framework/obsiddy/**` |
| Schema | `prisma/schema/framework-obsiddy.prisma` |
| Tables | `framework_obsiddy_*` |
| Seeds | `prisma/seeds/framework-obsiddy/001-*.ts` onward |
| Docs | `.context/framework/obsiddy/**` (this folder) |
| Routes | `app/(protected)/obsiddy/**`, `app/api/v1/obsiddy/**` |
| Components | `components/obsiddy/**` |

Namespaced *inside* the tier, never at its root — so a project already running another framework layer can add Obsiddy as a sibling rather than colliding.

## The two rules

1. **Obsiddy touches zero Sunrise-owned files.** Every such edit is a merge conflict inflicted on every host project. Two seams need upstreaming to Sunrise before that holds (`lib/app/maintenance-tasks.ts`, `lib/app/protected-nav.ts`) — see the plan, phase 0b.
2. **Seeds number from `001` inside `prisma/seeds/framework-obsiddy/`.** The runner discovers seeds recursively and `SeedHistory` keys on the path relative to `prisma/seeds/`, so Obsiddy's numbering cannot collide with a host's own seeds.

## Contents

| File | What it is |
| --- | --- |
| [`plan.md`](./plan.md) | The full implementation plan — data model, migrations, API, agents, workflows, prioritisation, lifecycle, boards, sharing, Obsidian sync, phasing, verification, risks |
| `install.md` | *(not yet written — phase 0 deliverable)* How a host Sunrise project installs Obsiddy |

`plan.md` is the working copy that travels with the code. It is not auto-synced with any copy held outside the repository.

## Status

Planning. No Obsiddy code exists yet; this repository is Sunrise at the point of forking, plus this documentation.
