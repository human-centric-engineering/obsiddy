# MCP — the brain, from inside your editor

Eight tools and three prompts, and **not one line of Obsiddy MCP code**. The
whole feature is two kinds of database row seeded by
[`prisma/seeds/framework-obsiddy/006-mcp.ts`](../../../prisma/seeds/framework-obsiddy/006-mcp.ts)
from the manifest at
[`lib/framework/obsiddy/mcp/exposure.ts`](../../../lib/framework/obsiddy/mcp/exposure.ts).

That is not a happy accident. `protocol-handler.ts` sets
`CapabilityContext.userId` from the key's creator, and every Obsiddy capability
already refuses to run without a `userId` — so per-user isolation over MCP is
the same owner-scope guard as everywhere else, reached by a different door.
Phase 6 paid for this without knowing it.

## The gotcha, first

**`McpApiKey.scopedAgentId` does not narrow what a key can call.**

It reads as though it does — "this key is scoped to `obsiddy-companion`" — and
the scoping in `listMcpTools()` is real but **default-allow**: it drops only
capabilities that have an explicit `AiAgentCapability { isEnabled: false }` row
for that agent. Obsiddy's bindings work by _absence_. A capability an agent may
not use simply has no row, and a missing row means allowed.

So every enabled `McpExposedTool` is callable by every key, whatever it is
scoped to. **The manifest is the access control**, which is why
`tests/unit/lib/framework/obsiddy/mcp/exposure.test.ts` asserts what is on it
and — more importantly — what is not.

What `scopedAgentId` _does_ buy is real, just narrower than it looks: cost and
budget attribute to that agent, and knowledge-base retrieval resolves through
its grants.

## What is exposed

| Tool                       | Reads or writes | Why it is on the list                                                                                                         |
| -------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `obsiddy_search`           | read            | The one that makes the rest worth having                                                                                      |
| `obsiddy_list_tasks`       | read            | "What should I be doing" from the ranked list, not from what is open in the editor                                            |
| `obsiddy_get_snapshot`     | read            | The whole picture in one call, instead of four searches reconstructing it                                                     |
| `obsiddy_find_connections` | read            | Proposals only — it reads the graph, it does not write a link                                                                 |
| `obsiddy_get_briefing`     | read            | Returns the stored briefing. No LLM call                                                                                      |
| `obsiddy_get_stale_digest` | read            | What has gone quiet, asked from anywhere rather than only from `/obsiddy/archive`                                             |
| `obsiddy_ideate`           | read, costed    | A pure read that bills an LLM call — `isIdempotent: false`, uncached, and the one an operator might turn off to control spend |
| `obsiddy_capture`          | **write**       | The premise. Adds an inbox item and nothing else                                                                              |

**Ten capabilities are deliberately absent.** Everything that creates structure
— `obsiddy_upsert_project`, `_goal`, `_entity`, `_task`, `obsiddy_link_entities`,
`obsiddy_promote_thought`, `obsiddy_write_review`, `obsiddy_reprioritise` —
because those are the person's own decisions about the shape of their work, they
change what the scorer surfaces tomorrow, and an MCP client is the one caller
with no UI in which to notice that they happened. `obsiddy_get_briefing_inputs`
and `obsiddy_notify` are absent for a duller reason: they are plumbing for the
briefing workflow and mean nothing outside it.

An operator who wants one of them can enable it at
`/admin/orchestration/mcp/tools`. The default should not make that choice for
them.

### Rows are seeded enabled

Against core's default-deny (`McpExposedTool.isEnabled @default(false)`). That
default protects against exposure nobody thought about; these rows are a curated
list with a written reason each, and two operator gates still stand in front of
them — `McpServerConfig.isEnabled` is false until someone turns the server on,
and nothing reaches the server without a minted key. Seeding them off would put
eight admin clicks between installing Obsiddy and the feature working, with no
decision made in between.

Re-seeding never re-enables a row an operator turned off. Same rule as
`004-agent-capabilities`: the update branch refreshes annotations and titles
(code artefacts — a stale `readOnlyHint` tells a client a write is safe to
retry) and leaves `isEnabled` alone.

## The three prompts

An MCP prompt is a **user-facing slash command**, not something the model
invokes on its own — the client expands the template into a message the person
sends. That makes a prompt the right shape for a _ritual_ and the wrong shape
for a lookup.

| Prompt                  | Arguments           | What it does                                                |
| ----------------------- | ------------------- | ----------------------------------------------------------- |
| `obsiddy-weekly-review` | `focus` (optional)  | Walks the review: what moved, what did not, what to archive |
| `obsiddy-what-now`      | `minutes`, `energy` | One thing to start, and why it and not the others           |
| `obsiddy-capture`       | `thought`           | Straight to the inbox, no filing, no follow-up questions    |

Templates are **not** rewritten on re-seed — only the description is. A template
is editable at `/admin/orchestration/mcp/prompts`, and overwriting an operator's
tuning every deploy is the same mistake `005-workflows` avoids with workflow
definitions. Prompt `name` is never updated at all: core makes it immutable
post-create, because a rename breaks every client that bookmarked the command.

## Setting it up

Three steps, all in the admin UI, none of them Obsiddy-specific.

1. **Turn the server on** — `/admin/orchestration/mcp/settings`, set
   `isEnabled`. Off by default.
2. **Mint a key** — `/admin/orchestration/mcp/keys`. Scopes: `tools:list`,
   `tools:execute`, `prompts:read`. The plaintext (`smcp_…`) is shown **once**.
   Set `scopedAgentId` to `obsiddy-companion` for cost attribution — but read
   [the gotcha](#the-gotcha-first) before treating it as a restriction.
   The key's **creator is the brain it reaches**, so mint it as the person whose
   brain it is.
3. **Point a client at it:**

   ```bash
   claude mcp add --transport http obsiddy https://your-host/api/v1/mcp \
     --header "Authorization: Bearer smcp_..."
   ```

   Then `what should I work on today?` and `capture that` work in the editor.

A running server caches both lists for five minutes. After a re-seed, restart or
wait before expecting `tools/list` to change.

## Resources: deferred, and why

The plan wanted `obsiddy://today` and `obsiddy://project/{slug}` as MCP
**resources** — a client can read a resource without spending a tool call, which
is the cheaper shape for a read.

They are not built. `resource-registry.ts` dispatches on `resourceType` through
a module-local `HANDLERS` map of core's four, which is neither exported nor
merged into, so a fork can insert the row and the registry logs "no handler for
type" and returns null. Filed as ask #32 in
[`sunrise-asks.md`](./sunrise-asks.md) →
[sunrise#540](https://github.com/human-centric-engineering/sunrise/issues/540).

Nothing is missing as a result — every read path is exposed as a tool and works.
The cost is one tool call where a resource read would have been free.

## See also

- [`agents.md`](./agents.md) — the binding model these rows sit alongside, and
  why absence is how a capability is withheld
- [`.context/orchestration/mcp.md`](../../orchestration/mcp.md) — core's MCP
  server: transport, auth, audit, session management
- [`install.md`](./install.md) — the operator steps, in the install checklist
