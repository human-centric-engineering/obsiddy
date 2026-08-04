# Obsiddy — framework-tier code

Phases 0–6b. One rule shapes the layout: **the database is reachable only from
`repo/**`** (`lib/framework/eslint.config.mjs`), which is what makes the
owner-scope contract structural rather than a convention.

| Path                                                       | What it is                                                                                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                                                 | `initObsiddy()` — the single entry point `lib/app/bootstrap.ts` imports **dynamically**; delegates to `lib/app/leaf-bootstrap.ts` |
| `env.ts`                                                   | `obsiddyEnvSchema` — merged by the host in `lib/app/env.ts`                                                                       |
| `agents.ts`                                                | The five agent slugs and the profile slug. Slugs only — prompt text is seed data                                                  |
| `validations.ts`                                           | Every Zod schema: route bodies, query params, and the `agent*Schema` capability arguments                                         |
| `repo/`                                                    | The only layer that may import Prisma. Every function takes an `OwnerScope`                                                       |
| `services/`                                                | Business logic. One implementation per operation, shared by the routes, the capabilities and MCP                                  |
| `capabilities/`                                            | The thirteen agent tools, their catalogue, and the scope guard they all inherit                                                   |
| `priority/`                                                | The pure scorer and the batched reprioritise pass                                                                                 |
| `embedding/`                                               | Canonical text, hashing, and the batched indexer                                                                                  |
| `search/`                                                  | Hybrid search and the connection sweep — orchestration only; the SQL lives in `repo/embeddings.ts`                                |
| `documents/`                                               | Upload ingestion, reusing the platform's parsers and chunker                                                                      |
| `ui/`                                                      | Route constants, wire-shape schemas, and the one server-read helper                                                               |
| `time/`                                                    | Zoned-time helpers — every schedule resolves in the user's own timezone                                                           |
| `*-nav.ts`, `rate-limit.ts`, `db-drift.ts`, `admin-nav.ts` | Registrars the host calls from its `lib/app/*` seams                                                                              |

The reasoning behind each layer lives in the docs, not here:
[`plan.md`](../../../.context/framework/obsiddy/plan.md) for the phasing,
[`agents.md`](../../../.context/framework/obsiddy/agents.md) for the agent layer,
[`ui.md`](../../../.context/framework/obsiddy/ui.md) for the surfaces, and
[`install.md`](../../../.context/framework/obsiddy/install.md) for how a host
project wires this tier up.

Namespaced _inside_ the tier: nothing goes in `lib/framework/` itself except the
shared tier `eslint.config.mjs`, so a project running another framework layer
can add Obsiddy as a sibling.
