# The agent layer, and the rules it follows

Phase 6b: fourteen capabilities, five agents, one shared profile, four seeds.
Phase 6c: the context block, the app-owned chat route, and the page. Together
they are what turns a searchable database into something you can talk to — and
the place where the isolation contract (D5) has to hold against an input nobody
wrote by hand.

Everything here lives in `lib/framework/obsiddy/{capabilities,context}/**`,
`app/api/v1/obsiddy/chat/**` and `prisma/seeds/framework-obsiddy/**`. Nothing in
it touches a Sunrise-owned file: the two registrations go through
`lib/app/capabilities.ts` and `lib/app/context-contributors.ts`, both fork-owned
scaffolds Sunrise ships empty and never changes.

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
because the failure this guards against is not a wrong check but a _fifteenth_
capability that never had one.

`userId` is `string | null`, and null is real: a system-initiated run with no
owner. Every capability returns `no_user_context` for it, asserted as a sweep
over all fourteen rather than a case per class.

---

## 3. Fourteen, not the plan's thirteen

`plan.md` §5 lists thirteen capabilities and none of them can mark a thought as
processed. Built exactly to that list, the nightly triage agent creates tasks,
asserts links — and leaves every thought sitting in the inbox looking untouched,
so the next night it processes the same twenty notes again and the person wakes
to a growing pile of duplicates beside them.

`obsiddy_promote_thought` closes it, wrapping the `promoteThought` service that
`POST /obsiddy/thoughts/[id]/promote` already calls. It has to be a capability
rather than two calls the model makes itself, because a create-then-update would
miss all three things the service exists for: `promotedToType` / `promotedToId`
(deliberately absent from the update schema), the `ObsiddyLink` back to the new
item, and the `promoted` event the weekly review counts.

**Dropping a thought is deliberately still not possible.** Promotion is additive
and visible; marking someone's note as rubbish is neither, and a nightly job that
does it unattended is a job they turn off. The triage prompt says to leave what it
cannot classify, and the absent capability is what makes that true rather than
hopeful.

---

## 4. What an agent cannot do

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

## 5. Redaction: prose out, structure in

Every Obsiddy capability sets `processesPii = true` — a brain is nothing but PII
— so the dispatcher refuses to register one that does not override
`redactProvenance`. Its check is an own-property test on the **immediate**
prototype, so an override inherited from `ObsiddyCapability` would not satisfy
it. That is why there are fourteen overrides rather than one, and it is the right
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

## 6. Provenance out, for the trace UI

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

## 7. The five agents, and why they differ

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

## 8. Bindings are the enforcement

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

## 9. Adding a fifteenth capability

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

**You do not need to touch the seeds' `hashInputs`.** `001-capabilities` and
`004-agent-capabilities` already fold `catalogue.ts` into their content hash, so
editing the catalogue is what makes them re-run. That declaration is load-bearing
rather than tidy: the runner hashes a unit's own source, those two files barely
change, and without it a host upgrading Obsiddy gets the new tool's code and no
row for it — which the dispatcher then refuses at `capability_inactive`.

---

## 10. The context block (6c)

An agent with tools but no orientation is a search box with a personality. The
`obsiddy` context contributor injects one `LOCKED CONTEXT` block per turn:
today's date and timezone, goals longest-horizon-first, active projects with days
since activity, the top five tasks with the scorer's own word for why, inbox and
capacity, and area balance.

Three rules, each because breaking it is invisible:

1. **The loader reads `request.userId` and ignores `id`.** `buildContext` caches
   on `type:id:userId`. A loader that trusted `id` would render one person's
   goals into another person's prompt — and then serve the cached answer for the
   rest of the TTL. The chat route also pins `contextId` server-side; both halves
   exist because either alone is one refactor from being wrong.
2. **It is capped, twice.** Per-section row caps stop a corpus of four hundred
   projects becoming four hundred lines; a ~1200-token character budget catches
   what those cannot, and truncates on whole lines because half an id in a prompt
   is worse than no id — the model will try to use it.
3. **Invalidation lives in `recordObsiddyEvent`, not at each call site.** Every
   mutation in the tier records an event, so no service can forget — including
   ones written later. `reprioritiseTasks` is the one exception (it records no
   event and is precisely what reorders `TOP TASKS`), so it invalidates directly.

What the block deliberately omits: task notes, thought bodies, document text.
That is what `obsiddy_search` is for, and carrying it here would spend the budget
on whatever happened to be recent rather than on what the person is trying to do.

## 11. The chat route, and why it exists

`POST /api/v1/obsiddy/chat/stream`. The platform ships two chat routes and
neither fits: the consumer route **drops `contextType`/`contextId`** (admin-only
concepts there — and they are exactly what the block travels on), and the admin
route requires `withAdminAuth`.

Two things are pinned server-side, and one is checked:

- `contextType` / `contextId` — the latter is `session.user.id`, never a body
  field. The request schema has no such key, so an attempt is a 400 rather than a
  silently ignored one.
- `agentSlug` against `OBSIDDY_CHAT_AGENT_SLUGS`, which today is the companion
  alone. `streamChat` does **not** gate on `AiAgent.visibility` — that is what
  lets the companion stay `internal` — so this route is the only thing between a
  browser and `obsiddy-triage`, an agent with write capabilities tuned for an
  unattended run. An unknown slug and a restricted one get the same answer.

Rate limit: `obsiddy-chat`, 20/min on the session user. A per-minute cap because
chat is genuinely conversational; the per-_turn_ spend ceiling is separate and
lives on the agent row (`maxCostPerTurnUsd`). Neither substitutes for the other.

## 12. The chat UI is Obsiddy's own

`components/obsiddy/chat/obsiddy-chat.tsx`, not Sunrise's `<ChatInterface>`.
That component posts to a hardcoded `API.ADMIN.ORCHESTRATION.CHAT_STREAM` with no
prop for the endpoint (ask #26), so reusing it would mean editing a Sunrise-owned
file.

The rebuild turned out to be the right shape anyway: most of what the admin
component carries is admin-only — per-turn cost, token breakdowns, the
tool-argument trace strip. On a personal brain the trace strip would render the
user's own note text back through a surface with different redaction rules, and a
cost readout puts a price tag on thinking out loud.

What it does keep from the platform is the part that is genuinely shared:
`parseChatStreamEvent` (the wire contract — a second copy of that Zod union is a
second thing to keep in step with the handler) and `getUserFacingError`.

What it adds: **a chip naming which tools ran**, in the user's terms — "searched
your brain", "captured a thought". This agent can write, and an assistant that
quietly created three tasks while answering a question is the thing people stop
trusting. Naming the writes is cheaper than an approval gate and catches the same
surprise.

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
