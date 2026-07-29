---
name: pr-gates
description: |
  Runs this repo's full pre-merge gate suite on the current branch and fixes what
  it finds, looping until every gate is clean. Use when the user says "run the
  gates", "get this branch ready to merge", "ready this branch for a PR",
  "green-light this branch before a PR", or asks for a pre-merge check of the
  working branch. Runs the deterministic checklist (`/pre-pr`), `/test-coverage
  branch`, `/security-review` and `/code-review` in that order, auto-fixes the
  clear-cut, and escalates judgement calls in one batched question. It does NOT
  commit, push, or open the PR — it leaves the working tree modified and
  uncommitted, and those steps stay the user's.
---

# PR Gates

Drive this branch to a clean pre-merge state. Run the gates, fix what is clearly
fixable, escalate what is not, and re-run until a full pass produces nothing new.

**The deliverable is a working tree that passes every gate.** Not a commit, not a
PR — see [Never do](#never-do).

## Resolve the base ref first

Every gate scopes to the branch diff. Local `main` is often stale, so always use
the remote merge base:

```bash
git fetch origin main --quiet
BASE=$(git merge-base origin/main HEAD)
git diff --name-only "$BASE"...HEAD
```

Report the short hash of `$BASE` in the final report so the scope is verifiable.

## Gate order

Cheapest and most deterministic first. **Nothing later is worth running until
gate 1 is green** — a type error or a failing test invalidates the premise the
review gates reason from, and a reviewer subagent that trips over a compile error
spends its budget describing it instead of finding the real defect.

| #   | Gate                      | Command                 | Why here                                                                                       |
| --- | ------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | Deterministic checklist   | `/pre-pr`               | Machine-checkable, no model judgement, fastest signal. Everything else assumes it passes.      |
| 2   | Coverage on the diff      | `/test-coverage branch` | Cheap, still mostly mechanical. Untested changed code makes every later finding harder to fix. |
| 3   | Security pass on the diff | `/security-review`      | Model judgement, narrow lens. Runs before general review because its findings outrank style.   |
| 4   | Correctness + simplify    | `/code-review`          | Broadest and most expensive. Worth the most on code that already compiles, passes and is safe. |

`/pre-pr` and `/test-coverage` are this repo's own commands (`.claude/commands/`).
`/security-review` and `/code-review` are built-in Claude Code commands.

### What gate 1 actually runs

`/pre-pr` wraps the deterministic checks, so prefer it. If you need to run them
directly (a targeted re-check after a fix, say), these are the real commands:

```bash
npm run validate                 # type-check + lint + format:check, in that order
npm run type-check               # tsc --noEmit
npm run lint                     # eslint . (cached)
npm run lint:fix                 # eslint --fix — safe auto-fix
npm run format                   # prettier --write — safe auto-fix
npm run format:check             # prettier --check
npx vitest run                   # full suite, single pass — ~4 min, the arbiter
npx vitest run --coverage        # + coverage/coverage-summary.json — ~39 min
npm run db:drift-check           # ONLY if the branch touched prisma/
```

Three gotchas that will otherwise cost you a run:

- **Use `npx vitest run`, not `npm run test`.** `"test": "vitest"` can enter watch
  mode and hang. Same for coverage: `npx vitest run --coverage` over
  `npm run test:coverage`.
- **`db:drift-check` exit codes are three-valued.** `0` pass · `1` fail — a
  migration on this branch dropped a Prisma-unmodellable object (HNSW index,
  tsvector/GIN index, a hand-written FK); this is a **stop and report**, see
  [Repo boundaries](#repo-boundaries--never-edit-these-to-pass-a-gate) · `2`
  skipped, local DB unreachable — record it, do not fail the run on it.

- **A failing `--coverage` run writes no coverage report.** Vitest exits before
  generating it, so you get the failures _and_ an empty `coverage/` — the worst of
  both. Get gate 1 green first, then measure coverage; and prefer scoping the
  coverage run to the branch's own suites (`npx vitest run --coverage <dirs>`),
  which takes seconds rather than 39 minutes and reports the same per-file numbers
  for the files you care about.

Coverage thresholds are **80%** on lines, branches, functions and statements
(`vitest.config.ts`), per-file data in `coverage/coverage-summary.json`.

## Arguments

`$ARGUMENTS` is optional and free-form. Parse it for:

- **Gate subset** — any of `pre-pr`, `coverage`, `security`, `review` (also
  accept `code-review`, `test-coverage`, `security-review`). Default: all four.
  Whatever the subset, keep them in the order above.
- **Effort for `/code-review`** — `low` | `medium` | `high` | `max`. Default
  `high`.

Ignore tokens you don't recognise; don't ask what they meant, and don't let an
unknown token narrow the run. Say in the final report which gates ran and at what
effort.

Examples: `pre-pr coverage` → gates 1–2 only. `max` → all four, `/code-review` at
max. `security review high` → gates 3–4 at high.

## Operating principles

**Converge to a fixed point, don't take one shot.** After any fix, re-run the
gates that fix could have affected — always gate 1, plus the gate that raised the
finding. You are done when a complete pass over the selected gates yields zero
new actionable findings, not when you have replied to every finding once.

**Fix the clear-cut yourself, without asking:**

- Type errors, lint violations, formatting.
- Failing tests that are fixable without changing intended behaviour — a test
  asserting a stale shape, a missing mock, a renamed import.
- Missing tests for code this branch changed.
- Mechanical convention violations: relative imports instead of `@/`, `console.*`
  instead of `logger` from `@/lib/logging`, an unvalidated `request.json()` that
  needs the Zod schema already sitting next to it, a missing `withAuth()` wrapper.
- Any review finding with one unambiguous correct fix.

**Stop and ask when the fix is a decision, not a correction.** Batch every such
finding into **one** `AskUserQuestion` call at the end of a pass — never one call
per finding. Ask when a finding:

- changes intended behaviour or product scope;
- is a security finding whose remedy is a design choice (where the boundary goes,
  what the threat model is, whether to accept a documented risk);
- is a quality gap the user may consciously be accepting (a deliberate coverage
  hole, a known-slow path, a TODO with a ticket);
- is uncertain enough that guessing risks the wrong fix — including any finding
  you cannot reproduce from the code in front of you.

**Stay inside the branch's intent.** Fix what the gates flag on the diff. No
unrelated refactors, no drive-by improvements, no widening scope because a nearby
file looks poor. A gate finding on code this branch did not touch is a report
item, not a work item.

### Repo boundaries — never edit these to pass a gate

This is a **Sunrise-based fork carrying a `/framework` tier** (Obsiddy, under
`lib/framework/obsiddy/`). Some files are owned upstream or hand-written, and
"make the gate green" is exactly how they get quietly broken. If a gate finding
points at one of these, **surface it — do not edit it**:

- **Sunrise-owned files.** The fork's contract (`CLAUDE.md`,
  `.context/framework/obsiddy/install.md`) is that Obsiddy touches only `lib/app/*`
  seams, the reserved `/app` and `/framework` namespaces, and one namespaced
  `package.json` script line. Editing anything else upstream-owned inflicts a
  merge conflict on every host project. The correct response is a row in
  `.context/framework/obsiddy/sunrise-asks.md` plus an upstream issue — report it,
  and let the user decide.
- **Hand-edited migrations** under `prisma/migrations/` (`add_second_brain`,
  `obsiddy_space_cascade`). They carry Postgres objects Prisma cannot model. Never
  regenerate one to resolve a drift failure — a red `db:drift-check` means a
  generated migration dropped a real object, and the fix is to edit the _offending_
  migration's spurious `DROP`, then re-author with
  `prisma migrate dev --create-only`. If you are not certain which, escalate.
- **`package.json` script names.** `CUSTOMIZATION.md` §7 reserves the unprefixed
  names (`smoke:*`, `db:*`, `test:*`, …) for the platform. Fork scripts are
  namespaced (`app:*`, `framework:<tier>:*`) and appended at the end of the block.
- **Generated output** — `coverage/`, `.next/`, Prisma client artefacts. Never edit
  to move a number.

Adding a suppression (`eslint-disable`, `@ts-expect-error`, `it.skip`) to silence
a gate counts as editing to pass. Fix the cause or escalate.

### Never do

Do not `git commit`, `git add` with intent to commit, `git push`, `gh pr create`,
or amend anything. Mutate the working tree only. The final report ends with the
tree modified-but-uncommitted and the next step explicitly the user's — they may
want to review, split, or reword before any of that happens.

## The convergence loop

```
BASE  = merge-base(origin/main, HEAD)
GATES = parse($ARGUMENTS) or [pre-pr, coverage, security, review]
EFFORT = parse($ARGUMENTS) or "high"

pass = 0
escalations = []          # accumulated across passes, asked once at the end
history = {}              # finding fingerprint -> times seen, for oscillation detection

while pass < 3:
    pass += 1
    new_findings_this_pass = 0

    for gate in GATES (in canonical order):
        rounds = 0
        while rounds < 2:
            findings = run(gate)                     # gate 1 first; if it fails, later
                                                     # gates are not run this pass
            if findings is empty: break

            for f in findings:
                history[fingerprint(f)] += 1
                if history[fingerprint(f)] > 1:      # reappeared after a "fix"
                    escalations.append(f, reason="oscillating — fix wrong or false positive")
                    continue                          # stop fixing it
                if auto_fixable(f):  apply_fix(f)
                else:                escalations.append(f)

            new_findings_this_pass += count(findings)
            rounds += 1

            if any fix applied:
                run(gate 1)                          # prove no regression before moving on
                if gate 1 regressed: fix that first, then re-run this gate

        if rounds == 2 and gate still has findings:
            escalations.append(residue of gate, reason="fix-round cap reached")

        if gate == 1 and gate 1 not green:
            break                                     # do not run gates 2–4 on a red tree

    if new_findings_this_pass == 0:
        break                                         # fixed point reached

if escalations not empty:
    ONE AskUserQuestion call, all escalations batched
    apply whatever the answers authorise, then re-run gate 1 (+ affected gates)

report(status per gate, fixes applied, what remains, caps hit, tree uncommitted)
```

## Caps

- **3 full passes** maximum.
- **2 fix rounds** within a single gate before escalating that gate's residue.
- **Oscillation stops fixing immediately.** If a finding reappears after you
  "fixed" it, do not fix it a third way — the fix is wrong or the finding is a
  false positive, and both are the user's call. Escalate with both attempts shown.

**Always report a cap when you hit one**, in the gate's status line and again in
the summary. A silent cap reads as "all clear" when it is the opposite — that is
the single worst failure mode of this skill.

## Per-gate guidance

**1 · `/pre-pr`.** Take its output as a work-list. Formatting and lint: run
`npm run format` / `npm run lint:fix` rather than hand-editing. Type errors: fix
at the source, never with `@ts-expect-error`. Its anti-pattern scan (4a–4l) is
mechanical and its findings are almost all auto-fixable — the exceptions are 4f
(missing tests, route to gate 2's tooling) and its documentation/CHANGELOG checks
in step 5, which are reminders, not gates: judge whether the branch really changed
the public surface (`VERSIONING.md`) before adding a CHANGELOG bullet, and don't
add one for internal work. Known flake: full-suite runs occasionally fail 1–5
admin/orchestration UI tests on `waitFor` timeouts that pass in isolation. Re-run
the failing file alone (`npx vitest run <path>`) before treating it as real; if it
passes, note it as a flake, don't "fix" it.

**But isolation is not proof, and this is the trap that has already cost a
retracted upstream bug report.** Every timeout-shaped failure in this repo is
load-sensitive, and a re-run started in the shadow of a long job inherits that
load — a quiet shell is not an idle machine. `--coverage` is the usual culprit:
it costs **10× wall-clock** here (2340s vs 219s for the same suite), so the
minutes after a coverage run are the _worst_ time to judge a flake. Before
concluding "reproduces in isolation, therefore real":

- Wait for every background job to finish, then re-run — not immediately after.
- Prefer a **full suite without `--coverage`** as the arbiter. It is ~4 minutes
  and it is the run that matters; a green full suite outranks a red single file.
- Treat a failure that is _only_ `Test timed out in Nms` as load-suspect by
  default, whatever the file. Real logic breaks assert something specific.
- Never file upstream, or attribute a failure to the fork point, on the strength
  of consecutive reproductions inside one loaded window.

**2 · `/test-coverage branch`.** This scopes coverage to the branch diff against
`origin/main` — the right lens here; leave the whole-project mode alone. For
anything beyond a couple of test cases, **do not write tests inline**: run
`/test-write` (which spawns `test-engineer` subagents) or spawn the `test-engineer`
agent directly. It knows this repo's `.context/testing/` patterns, mock
conventions and the anti-green-bar rule, and it validates that new tests pass lint
and type-check before finishing. Inline authoring is fine only for a one-case gap
in a file you already have open. Coverage below 80% on a file the branch barely
touched is a report item, not necessarily a work item — say so rather than
inflating it with shallow tests.

**3 · `/security-review`.** Read every finding against the actual diff before
acting; a security fix applied to misread code is worse than the finding. Fix
without asking where the remedy is unambiguous and local — a missing Zod parse on
a request body, a missing auth guard, an unescaped interpolation, a leaked value
in a log line. Escalate anything that moves a trust boundary, changes what an
endpoint is allowed to do, weakens or strengthens an existing policy, or trades
security against a product decision. Note that 404-not-403 on cross-user access is
deliberate in this codebase — a "should be 403" finding is a false positive.

**4 · `/code-review`.** Run at the effort from `$ARGUMENTS` (default `high`).
`/code-review --fix` will apply its own findings, which is efficient for a batch
of mechanical ones — if you use it, **re-run gate 1 immediately afterwards** to
prove it broke nothing, and read its diff rather than trusting it blind. Take
correctness findings seriously and simplification findings on their merits:
"simpler" that changes behaviour is not simpler, it's a rewrite, and belongs in
escalations. Findings about code the branch did not touch go in the report, not
the working tree.

## Final report

One block per gate, then the summary. No preamble.

```
## PR Gates — <branch> (base <short-hash>)
Gates run: <list> · code-review effort: <level> · passes: N/3

### 1 · Deterministic checklist (/pre-pr)
Status: clean | fixed N | needs-human N | CAP HIT (2 fix rounds)
- <file:line> — <what was fixed, and why it was safe to fix>

### 2 · Coverage on the diff (/test-coverage branch)
Status: ...
- <file> — <tests added, by whom (inline / test-engineer), what they cover>

### 3 · Security (/security-review)
Status: ...

### 4 · Correctness + simplification (/code-review, effort <level>)
Status: ...

### Needs your decision
1. <finding> — <why it is not mine to decide> — <options as put to you>
   (empty if none, and say so)

### Not fixed, and why
- <finding> — <boundary rule / cap hit / oscillating / out of branch scope>

### State
Working tree: modified, NOT committed. N files changed.
Verified: <the exact commands re-run last, and their result>
Next step is yours: review the diff, then commit / push / open the PR.
```

Report faithfully. If a gate was skipped, say which and why. If the suite still
has a failure you could not resolve, print the failing output rather than
characterising it. "Fixed N" means the gate was re-run and is green — if you did
not re-run it, it is not fixed.
