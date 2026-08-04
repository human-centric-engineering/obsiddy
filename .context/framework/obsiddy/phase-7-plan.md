# Phase 7 — the background, and the briefing

**Status: agreed 2026-08-04, in build.** Phase 7 is the first phase whose plan
needed correcting before it could be built: three of `plan.md` §6's mechanisms
turned out to describe step types that do something other than what the plan
assumed. Those corrections are §1 below and are **now folded into `plan.md` §6**,
which stays the source of truth — this file is the working doc that carries the
reasoning and the build order.

Phase 7's deliverable, from `plan.md` §15: six workflows including
`obsiddy-morning-briefing`, the `obsiddy-briefer` agent, the `workStyle`
setting, the briefing button on Today, `ensureObsiddySchedules()` and
notification emails. Verifiable by: force-tick with cron `* * * * *`; the button
returns a stored briefing with no LLM call.

**One column, and phase 1 bought the rest.** Everything the briefing and the
workflows write to already exists — `workStyle` is on `ObsiddySpace`
(`framework-obsiddy.prisma:69`), `'briefing'` is already a valid review horizon
(`validations.ts:788`), and `ObsiddyEvent` has a `'completed'` kind
(`repo/events.ts:26`) with a `kind` filter on `listEvents`. The single addition
is `ObsiddySpace.lastSweptAt`, the across-users cursor the connection job needs
(§7.3) — one nullable column on the one-row-per-user table.

---

## 1. Three corrections to `plan.md` §6

Each was verified against the executor source, not inferred. Each changes what
gets built.

### 1a. `report` renders the trace, not the domain

`plan.md` §6 has the briefing's step 2 as **"`report` — the factual half
rendered deterministically, no LLM: completed counts and titles, overdue list,
capacity remaining, WIP state"**, and then prices the whole briefing at one small
LLM call on the strength of it.

`report` does not do that. It calls `renderExecutionMarkdown`
(`lib/orchestration/trace/render-markdown.ts`), which renders **the workflow's
own execution trace** — steps, statuses, tokens, cost, the supervisor's verdict.
It is a debugging and audit artefact. Pointed at a briefing it would emit a
description of the briefing workflow's own steps, which is not something anyone
wants to read over coffee.

**What to build instead.** The factual half is a _service_, not a step type:
`services/briefing-facts.ts` renders deterministic Markdown from a snapshot plus
the recent-wins query. It is called by the capability, so it is one function with
one test, reachable from the workflow, the API and MCP alike — which is the same
rule §3 of `plan.md` already applies to everything else.

The cost estimate survives: still one small LLM call per day, because the facts
are still rendered without one. Only the mechanism changes.

### 1b. `route` is an LLM classifier, and `workStyle` is a column we already have

`plan.md` §6 step 3 is **"`route` on `workStyle` → three branches"**.

`route` (`executors/route.ts`) builds a classification prompt, sends it to an
LLM, and matches the reply against the declared branch labels. Using it to branch
on `ObsiddySpace.workStyle` would spend a second LLM call to read a
`VarChar(16)` enum we can select — and, being a model, it can return the wrong
one. Deciding a user's briefing style by asking a language model to guess a value
already stored is a defect with a per-day cost attached.

**What to build instead.** No DAG branch at all. `obsiddy_get_briefing_inputs`
reads `workStyle` server-side, performs the per-style _selection_ the §6 table
specifies, and returns both the selected data and the prompt key. One `llm_call`
interpolates it. This keeps the plan's real requirement — **`workStyle` changes
what data is selected, not just the wording** — while deleting a branch, a step
type and an LLM call.

`guard` in `schema` mode is the deterministic branch primitive if a future
workflow genuinely needs one, but it resolves `pass`/`fail`, so it is a two-way
gate rather than a three-way switch. Worth knowing; not needed here.

### 1c. A per-user schedule row outlives the user

This one is a privacy defect, not an efficiency one, and it is new to phase 7.

Every Obsiddy table to date hangs off `ObsiddySpace` and cascades on erasure —
which is why the tier registers no `registerErasureCleanupHook` today and has
never needed one. `ensureObsiddySchedules()` breaks that: it writes rows to
**`AiWorkflowSchedule`**, a core-owned table whose `createdBy` is
**`onDelete: SetNull`** (`orchestration-workflows.prisma:95`).

So after `eraseUser()`, a deleted user's four schedule rows survive, `isEnabled:
true`, with a live `nextRunAt` — firing workflows for ever against a `userId`
that resolves to nothing. Two consequences:

- **The schedule must not carry the email address.** `send_notification`
  resolves `to` from `{{input.userEmail}}`, so the obvious implementation stamps
  the address into `AiWorkflowSchedule.inputTemplate` — where it becomes exactly
  the orphaned-PII shape `plan.md` §7 rejected `logEvent()` for. `inputTemplate`
  carries `{ userId }` only; the address is resolved at send time from the
  userId, inside the tier, by `obsiddy_notify`.
- **Phase 7 registers the tier's first erasure cleanup hook**, deleting the
  user's Obsiddy schedule rows. `registerErasureCleanupHook`
  (`lib/privacy/erasure-hooks.ts:74`) is the seam. This is a phase 7 deliverable,
  not a Release 2 one — Release 2's phase 14 hook then extends it rather than
  introducing it.

---

## 2. What is already in place

Verified present, so phase 7 builds on it rather than around it.

| Needed                     | Where it is                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Per-user execution scoping | `scheduler.ts:335` stamps `userId: schedule.createdBy` onto the execution — the mechanism holds after the upstream merge (`plan.md` cites the pre-merge line 314)                                |
| The tick that drives it    | `run-tick.ts:171` calls `processDueSchedules()`; app jobs run alongside under the same tick                                                                                                      |
| The app-job seam           | `lib/app/jobs.ts` — shipped empty by upstream #469, `registerAppJob({ name, intervalMs, run })`                                                                                                  |
| Every step type §6 names   | `report`, `route`, `judge-call`, `orchestrator`, `notification`, `guard`, `llm-call`, `agent-call`, `tool-call` all registered                                                                   |
| The email template         | `emails/workflow-notification.tsx`, used by `send_notification` — **Obsiddy needs no template of its own**, so nothing new lands in the core-owned `emails/` directory. Read §2a before using it |
| Workflow seeding precedent | `prisma/seeds/004-builtin-templates.ts` → `createInitialVersion` from `workflows/version-service`                                                                                                |
| The snapshot               | `services/snapshot.ts` — `SnapshotPayload` already carries `workStyle`, capacity, counts, goals, projects, `topTasks`, areas, `mostNeglectedArea`                                                |
| The schedule hook point    | `services/space.ts:80`, stubbed with a comment naming `ensureObsiddySchedules(userId)`                                                                                                           |
| Review storage             | `repo/reviews.ts` — write path landed in phase 6 precisely so the workflows would have somewhere to put output                                                                                   |

### 2a. The email template takes plain text, and the briefing should not be in it

`WorkflowNotification` takes `{ body, workflowName }` and renders `body` into a
single `<Text>`. Two consequences, one benign and one that decides a design:

- **Newlines survive** — the style sets `whiteSpace: 'pre-wrap'`, so a multi-line
  body arrives intact.
- **Markdown does not render.** A `##` heading arrives as the characters `##`.
  Anything sent through this template must be written as plain text, not as the
  Markdown the stored review holds.

That is the small half. The larger one: **the notification should say the
briefing is ready and link to it, not contain it.** Mailing the whole briefing
copies goals, project names, overdue task titles and the week's completions into
an inbox and any number of mail servers — durable, unrevocable, and outside every
guarantee the rest of the tier makes about where brain content lives. `plan.md`
§7 already refused to let `logEvent()` carry personal content for a weaker
version of this reason. A subject line, one sentence and a link cost nothing and
keep the content behind the session.

This also disposes of the Markdown problem rather than working around it: a
one-sentence notification has no headings to lose.

### 2b. The snapshot gap, and why it stays a gap

`SnapshotPayload` has no "what you completed" section, and `plan.md` §6 is
explicit that this is the payoff for having an append-only `ObsiddyEvent` table
at all — _"a planner that only ever shows what's outstanding is a machine for
feeling behind"_. `listEvents({ kind: 'completed' })` is a query away; the
aggregation is not written.

Phase 7 adds `services/recent-wins.ts` rather than widening the snapshot.
`contributor.ts:244` calls `buildSnapshot` to build the `LOCKED CONTEXT` block on
**every chat turn** — so a 7-day event scan added to the snapshot would be paid
on every message the user sends, to serve one screen they look at once a day. The
briefing composes the two; the per-turn path keeps paying for only what it reads.

---

## 3. The build, in order

Six steps. Each is independently reviewable and the order is a dependency order,
not a preference.

### 7.1 — The deterministic half

`services/recent-wins.ts` (completed events over a window, grouped by type) and
`services/briefing-facts.ts` (snapshot + wins → Markdown). Pure functions over
repo reads, no LLM, no workflow. Tested as functions.

This lands first because it is the half that must be right whether or not the
model is having a good day, and because 7.2 and 7.5 both consume it.

### 7.2 — Capabilities

Three, taking the catalogue from fourteen to seventeen:

| Slug                          | Does                                                                                                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `obsiddy_get_briefing`        | Serves the stored `ObsiddyReview{horizon:'briefing'}`; regenerates only past the staleness window. The one `plan.md` §15 listed under phase 6 and phase 6 correctly deferred |
| `obsiddy_get_briefing_inputs` | Reads `workStyle`, applies the §6 selection table, returns data + prompt key (correction 1b)                                                                                 |
| `obsiddy_notify`              | Resolves the address from `context.userId` and sends. Exists so no stored config carries an email (correction 1c)                                                            |

All three follow the phase 6 rules unchanged: `ObsiddyCapability` mints the
`OwnerScope`, `redactProvenance` keeps ids and masks prose, and the catalogue
`as const` map keeps a typo in a seed a build error.

`obsiddy_notify` is the one to watch in review — a capability that sends mail is
a capability that can be made to send mail. It takes no address argument, only a
body and a subject key, and it is bound to no agent the user can talk to.

### 7.3 — `ensureObsiddySchedules()` + the erasure hook

Idempotent creation of the per-user schedule rows, called from the stub at
`services/space.ts:80`, keyed so a second call is a no-op. `inputTemplate` is
`{ userId }` and nothing else. Registers the tier's first erasure cleanup hook in
the same change — the hook and the rows it cleans up should never exist in
different commits.

**`obsiddy-connection-finder` rides `registerAppJob`, not a cron schedule.**
`sweepConnections(scope)` is already a per-user sweep over stored vectors with an
internal rotation (`markSwept` stamps `sweptAt`, candidates are ordered by it) and
pair exclusion in the query — idempotent and resumable by construction, which is
the shape #469's `intervalMs` was argued for and the shape a cron row fits badly.
The other four stay on `AiWorkflowSchedule` because they are genuinely calendar
events — "9am on the 1st", "Friday at 16:00" — and because the user's timezone
has to resolve them.

**The job needs a second cursor, across users.** This is the part that does not
fall out of the existing sweep. `registerAppJob` fires **one process-wide
callback**, while `sweepConnections` takes an `OwnerScope` — so the job has to
choose whose brain to sweep. Sweeping everyone per tick is unbounded work on a
tick with a 60-second budget; sweeping "the first N" re-sweeps the same N for
ever, which is precisely the bug the per-type cursor was added to fix
(`README.md`, search property 5) reappearing one level up.

So the job pages through spaces oldest-swept-first, a small batch per tick, and
stamps as it goes — the same pattern as the sweep's own rotation, applied to
users. That needs:

- a `lastSweptAt` cursor per space. **This is the one schema change phase 7
  needs**, which makes the "no migration" claim above true of everything except
  this. It is one nullable column on a table with one row per user; it is not the
  kind of migration §2's drift-trap warning is about, but it is still a
  hand-edited migration and a `db:drift-check` run.
- a paged listing in `repo/space.ts` — there is currently no way to enumerate
  spaces at all (`findSpaceByUserId`, `findSpaceByToken`, `createSpace`,
  `updateSpaceSettings` are the whole surface), and `repo/**` is the only layer
  permitted to reach Prisma.

Both are small. They are called out because "move it to a job" sounds like a
one-line relocation and is not.

**Multi-instance:** `registerAppJob` keeps last-run times in process memory, so
_n_ instances run the job _n_ times per interval. With the cursor in the database
that is harmless — two instances racing take different batches or redo idempotent
work — but it must be stated in the job's own comment, because the next sweep
registered here might not be idempotent and the seam gives no warning.

`registerAppJob` keeps last-run times in **process memory**, so a multi-instance
deploy runs the sweep roughly once per instance per interval. The sweep is
already idempotent and cursor-driven, so this is survivable — but it must be
stated in the job's own comment, because the next sweep added here might not be.

**Do not import `@/lib/orchestration/scheduling` from the tier.** Found while
building this: that barrel pulls `scheduler.ts` → `OrchestrationEngine` → the
executors → the capability dispatcher → `lib/app/capabilities` → Obsiddy's own
capabilities → `services/resources` → `services/space` → back to the importer.
Importing `getNextRunAt` from it to compute one `nextRunAt` put
`schedules/ensure.ts` inside that ring.

The symptom is what makes this worth writing down. Not a stack overflow, not an
import error — a **partially-initialised `services/resources`**, whose effect was
that an unrelated suite's `vi.mock` silently stopped applying and five capability
tests went at a real database instead of their stubs. The failure named the
database, not the import. `cron-parser` is already a direct dependency and is a
leaf, so the fix was to parse the expression directly.

The same shape applies to the erasure hook's own dependency: keep tier modules
importing **leaves**, not barrels, and the graph stays shallow enough that a
mock means what it says.

### 7.4 — The five scheduled workflows

Seeded as `AiWorkflow` + `createInitialVersion`, following
`prisma/seeds/004-builtin-templates.ts`. Seeds `005`–`006` in
`prisma/seeds/framework-obsiddy/`.

`obsiddy-nightly-triage` · `obsiddy-weekly-review` · `obsiddy-horizon-check` ·
`obsiddy-capture-intake` · plus `obsiddy-connection-finder` as a job rather than
a workflow per 7.3.

Set `maxCostPerExecutionUsd` on **every** workflow. `plan.md` §6 is right that
the orchestrator step's `budgetLimitUsd` caps only that step, and a runaway
nightly job is the failure mode nobody notices until the invoice.

### 7.5 — The briefing

`obsiddy-morning-briefing`, chained off the nightly run: `obsiddy_get_briefing_inputs`
→ one `llm_call` → `obsiddy_write_review{horizon:'briefing'}` → `obsiddy_notify`.
Three steps and one LLM call, down from the plan's five steps, two LLM calls and
a three-way branch.

Plus the `obsiddy-briefer` agent (a sixth agent, sharing `obsiddy-core`),
`GET /obsiddy/briefing`, `POST /obsiddy/briefing/regenerate` with the
`workStyleOverride` escape hatch, and the button on Today.

**The acceptance test is that the button makes no LLM call.** Assert it on the
provider, the way `indexer.test.ts` asserts the embedder call count — a briefing
that quietly regenerates on every press is indistinguishable from a working one
until the bill arrives.

### 7.6 — The `workStyle` setting

The settings field with its `<FieldHelp>`, worded as `plan.md` §6 words it —
_"Do you want the morning briefing to lead with your task list, or with something
you might not have thought of?"_ — and the "surprise me today" per-briefing
override.

---

## 4. What phase 7 must not quietly become

- **`workStyle` does not touch `score.ts`.** Ranking stays deterministic and
  shared (D3). An exploratory user who wants urgency to matter less lowers the
  `urgency` weight in `priorityWeights`, through the same explicit-confirmation
  path as any other weight change.
- **No Sunrise-owned file is edited**, including `emails/`. The template already
  exists; if it turns out not to fit, the answer is an upstream ask, not a file.
- **7b is not phase 7.** MCP exposure, the admin-nav section, the iOS Shortcut
  and the eval dataset are a separate deliverable, and the eval dataset is the
  one that wants doing soon after — `plan.md` §7 notes there is currently no way
  to notice if nightly triage gets _worse_ after a prompt edit.

## 5. The operational risk, stated once

The dev in-process 60s ticker in `instrumentation.ts` covers local. **Production
needs external cron hitting `POST /api/v1/admin/orchestration/maintenance/tick`.**
`plan.md` §6 calls this the single most likely "why did nothing happen", and
phase 7 is the phase where it stops being theoretical: before it, nothing in
Obsiddy ran on its own. It belongs in `install.md` §2 as a required host step,
not a footnote.
