# The agent layer, and the rules it follows

Phase 6b: thirteen capabilities, five agents, one shared profile, four seeds.
This is what turns a searchable database into something you can talk to — and
the place where the isolation contract (D5) has to hold against an input nobody
wrote by hand.

Everything here lives in `lib/framework/obsiddy/capabilities/**` and
`prisma/seeds/framework-obsiddy/**`. Nothing in it touches a Sunrise-owned file:
the single registration goes through `lib/app/capabilities.ts`, the fork-owned
scaffold Sunrise ships empty and never changes.

## The one-line summary

An LLM can read the whole brain, write most of it, and influence none of the
ranking.

---

## 1. Four places, one truth

A capability exists in four places at once:

| Place                 | What it decides                             |
| --------------------- | ------------------------------------------- |
| A TypeScript class    | What running the tool actually does         |
| A Zod schema          | What arguments are accepted                 |
| An `AiCapability` row | Whether the tool exists and who may call it |
| A JSON function def   | **What the model is told the tool is**      |

Only the fourth changes the agent's behaviour, and it is the one nobody re-reads.
A function definition that drifts from its schema does not fail: the tool keeps
working while the model is steered toward a parameter that was removed six weeks
ago, and the symptom is "the agent stopped using that tool properly".

So the definitions live once, in
[`capabilities/catalogue.ts`](../../../lib/framework/obsiddy/capabilities/catalogue.ts),
as pure data with no service imports. The classes read their own entry; the seed
writes rows straight from the array; and `catalogue.test.ts` asserts —
mechanically, per capability — that every advertised parameter exists in the
matching Zod schema and vice versa.

Two smaller invariants ride along, both asserted:

- **`functionDefinition.name === slug`.** The chat handler's tool guard keys on
  the first while `dispatch` treats the same string as the second, and nothing in
  core requires them to agree ([sunrise ask #23](./sunrise-asks.md)). A mismatch
  is a tool that is advertised and then refused.
- **No `userId`, anywhere, at any depth.** Checked over the serialised parameter
  schema so a nested object property cannot smuggle one in.

---

## 2. The owner is never an argument

`CapabilityContext.userId` is set by the platform in exactly three places — the
session (`withAuth`), the schedule (`execution.userId = schedule.createdBy`), and
the MCP key's owner (`protocol-handler.ts` sets `userId: auth.createdBy`). None
of the three is reachable from a model.

`ObsiddyCapability` (in
[`capabilities/base.ts`](../../../lib/framework/obsiddy/capabilities/base.ts))
resolves that into an `OwnerScope` **before** a subclass's `run` is entered.
Subclasses receive the scope and have no way to ask for another one, so "I forgot
the check" is not a reachable state — which matters more than the check itself,
because the failure this guards against is not a wrong check but a fourteenth
capability that never had one.

`userId` is `string | null`, and null is real: a system-initiated run with no
owner. Every capability returns `no_user_context` for it, asserted as a sweep
over all thirteen rather than a case per class.

---

## 3. What an agent cannot do

Three things are withheld deliberately, and each is withheld structurally rather
than by instruction:

**It cannot pin a task.** `manualBoost` is the human's veto over the
deterministic ranking. The upsert schema `omit()`s all three boost fields, so
writing one is a type error; the catalogue test also asserts the string appears
in no advertised parameter schema. An agent that could pin has taken the veto
away, and would do it in a way that looks like the scorer's own output.

**It cannot supply a score.** `obsiddy_reprioritise` takes **no arguments at
all** — `z.object({}).strict()`. Not a weight, not a filter, not a list of ids.
It triggers the ranker; it does not steer it.

**It cannot forge provenance.** `obsiddy_capture` pins `source: 'agent'` rather
than accepting one, and `obsiddy_link_entities` cannot set `origin` or `status`
(the service pins `origin: 'user'`, `status: 'accepted'`). Provenance the caller
chooses is not provenance.

---

## 4. Redaction: prose out, structure in

Every Obsiddy capability sets `processesPii = true` — a brain is nothing but PII
— so the dispatcher refuses to register one that does not override
`redactProvenance`. Its check is an own-property test on the **immediate**
prototype, so an override inherited from `ObsiddyCapability` would not satisfy
it. That is why there are thirteen overrides rather than one, and it is the right
outcome: what is safe to keep for ever differs per tool.

The line every one of them draws: **`AiMessage.provenance` is outside the Obsiddy
erasure cascade.** Anything persisted there is a second copy of someone's notes
that "delete my account" does not reach.

| Kept                                                   | Masked                                                 |
| ------------------------------------------------------ | ------------------------------------------------------ |
| Ids, `type:id` refs, statuses, horizons, dates, counts | Titles, note bodies, descriptions, rationales, queries |
| `externalId` (a routing fact)                          | A person's name **and** their website                  |
| Which agent, which run, how many results               | The results themselves                                 |

An id resolves to nothing once the row is erased; a title would survive inside
the audit bundle. That asymmetry is the whole reason refs are the line.

`obsiddy_get_snapshot` keeps nothing at all. A snapshot minus its content is a
set of counts, and the counts are already in the payload the model received.

---

## 5. Provenance out, for the trace UI

The read capabilities return a `sources` array alongside their data. The engine
lifts `output.sources` off a `tool_call` step onto the trace entry, and the
approval and trace UI render it as pills — which is what turns "the agent
suggested this" into "the agent suggested this because of these four notes".

Source kind is `knowledge_base`. Core's enum is a closed set whose members are a
deliberate API decision, and a user's own corpus is its closest true member:
retrieved evidence surfaced into the prompt, not the model's parametric
knowledge. `reference` is `type:id`; `confidence` tracks the retrieval score
rather than being asserted flat, because a hit at 0.9 and one scraping the floor
are not equally good evidence.

---

## 6. The five agents, and why they differ

All five inherit the `obsiddy-core` profile — persona, guardrails, voice — and
carry only their own `systemInstructions`. `guardrailsMode` is `'append'`, not
the `'override'` default: no agent has its own guardrail text today, so the mode
is inert now, but the day someone adds one, append means "and also this" while
override would mean "instead of all the house rules", silently.

| Agent                | Temp | Why that number                                                                                                  |
| -------------------- | ---- | ---------------------------------------------------------------------------------------------------------------- |
| `obsiddy-companion`  | 0.4  | Warm enough to write readable prose, cold enough not to embellish someone's notes back at them                   |
| `obsiddy-triage`     | 0.1  | Classification. Divergence means the same thought filed two ways on two nights                                   |
| `obsiddy-connector`  | 0.6  | The highest, deliberately. A cautious connector produces "both of these are about marketing", which says nothing |
| `obsiddy-strategist` | 0.3  | A review is prose someone reads; 0.1 produces a bulleted list of database rows                                   |
| `obsiddy-judge`      | 0.0  | A judge whose score moves between identical runs cannot detect that anything changed                             |

Every agent sets all three guard modes **explicitly** rather than inheriting a
deployment default — an agent reading someone's private notes should not change
behaviour because an admin tuned a global for an unrelated chatbot. Nothing is
set to `block`: a blocked input silently loses a captured thought and a blocked
output hides someone's own notes from them, while `warn_and_continue` surfaces
the same signal and keeps the data.

`model` and `provider` are empty strings — the platform's "resolve at runtime"
contract. Pinning a model would make a fresh install fail on a provider it does
not have.

---

## 7. Bindings are the enforcement

An agent's instructions say what it should not do. The `AiAgentCapability` table
is what actually stops it: the chat handler advertises only the capabilities an
agent has an enabled row for, and refuses any tool name outside that set before
dispatch.

| Agent      | Bound to                                                                 | And notably not                         |
| ---------- | ------------------------------------------------------------------------ | --------------------------------------- |
| Companion  | The full working set, including capture and ideate                       | `write_review`, `reprioritise`          |
| Triage     | search, list, upsert **task**, link, connections, snapshot, reprioritise | upsert project / goal / entity, capture |
| Connector  | search, connections, snapshot                                            | **`link_entities`** — it proposes only  |
| Strategist | search, list, connections, snapshot, `write_review`                      | every other write                       |
| Judge      | **nothing**                                                              | everything                              |

Every "do not" in an agent's prompt that _could_ be a missing binding is one.
The judge's empty row set is asserted in the seed test, because the way it breaks
is somebody adding "just search" to make a rubric better.

**Revoke with `isEnabled: false`; never delete the row.** A missing pivot row
synthesizes a default-ALLOW binding in the dispatcher, so the intuitive action —
delete the permission — is the one that widens it.

---

## 8. Adding a fourteenth capability

1. Add the spec to `OBSIDDY_CAPABILITIES` in `catalogue.ts`, and the slug to
   `OBSIDDY_CAPABILITY_SLUGS`.
2. Add the argument schema to `validations.ts` under _Agent capability
   arguments_. No `userId`, no `manualBoost`, real booleans not string ones.
3. Write the class extending `ObsiddyCapability`, implementing `run` — **and its
   own `redactProvenance`**, or registration throws at first dispatch.
4. Add it to `obsiddyCapabilityHandlers()` in `capabilities/index.ts`.
5. Bind it to whichever agents genuinely need it in `004-agent-capabilities`, and
   say why in the `rationale` field.

`catalogue.test.ts` and `scope.test.ts` cover the new tool automatically —
neither enumerates capabilities by hand, which is the point.

---

## Where the rest of it lives

| Concern                                    | File                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| The catalogue and slugs                    | `lib/framework/obsiddy/capabilities/catalogue.ts`                         |
| The scope guard and redaction helpers      | `lib/framework/obsiddy/capabilities/base.ts`                              |
| The upsert body all four writes share      | `lib/framework/obsiddy/capabilities/upsert.ts`                            |
| Registration                               | `lib/framework/obsiddy/capabilities/index.ts` ← `lib/app/capabilities.ts` |
| Agent and profile slugs                    | `lib/framework/obsiddy/agents.ts`                                         |
| Prompts, personas, guardrails              | `prisma/seeds/framework-obsiddy/002-*`, `003-*` — never in `lib/`         |
| Neighbour hydration (shared with ideation) | `lib/framework/obsiddy/services/neighbours.ts`                            |

Prompt text is seed data, deliberately: an operator can edit it in the admin UI,
and a copy in `lib/` would silently disagree with the database the moment they
did — while being the copy nobody thinks to check.
