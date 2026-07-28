# Obsiddy — framework-tier code

Phase 0 (scaffold) only:

| File       | What it is                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts` | `initObsiddy()` — the single entry point `lib/app/bootstrap.ts` imports **dynamically**; delegates to `lib/app/leaf-bootstrap.ts` |
| `env.ts`   | `obsiddyEnvSchema` — merged by the host in `lib/app/env.ts`                                                                       |

Everything else is still to come. See
[`.context/framework/obsiddy/plan.md`](../../../.context/framework/obsiddy/plan.md)
for the phasing and
[`install.md`](../../../.context/framework/obsiddy/install.md) for how a host
project wires this tier up.

Namespaced _inside_ the tier: nothing goes in `lib/framework/` itself except the
shared tier `eslint.config.mjs`, so a project running another framework layer
can add Obsiddy as a sibling.
