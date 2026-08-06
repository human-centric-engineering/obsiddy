# Evaluating triage

`resparkable-triage` runs unattended at 03:15 and nobody reads its reasoning. Its
prompt is editable in the admin UI and its model is a dropdown, so the two
changes most likely to make it worse are the two easiest to make — and a triage
that has quietly got worse **looks exactly like one that is working**: the inbox
still empties. This is the thing that notices.

## What there is

| Piece        | Where                                                      | What it is                                                           |
| ------------ | ---------------------------------------------------------- | -------------------------------------------------------------------- |
| Thirty cases | `lib/framework/resparkable/evaluations/triage-cases.ts`    | Captured thoughts + the classification a human would have given them |
| The grader   | `lib/framework/resparkable/evaluations/triage-accuracy.ts` | `resparkable_triage_accuracy` — deterministic, no LLM call           |
| The runner   | `scripts/framework/resparkable/eval-triage.ts`             | `npm run framework:resparkable:eval-triage`                          |
| The dataset  | `prisma/seeds/framework-resparkable/007-eval-dataset.ts`   | The same thirty cases as `AiDataset` rows, visible in the admin UI   |

## Running it

```bash
npm run framework:resparkable:eval-triage -- --out=before.json
# edit the triage prompt at /admin/orchestration/agents/resparkable-triage
npm run framework:resparkable:eval-triage -- --out=after.json
```

```
  mean score  0.883
  pass rate   80%  (30 scored)
  cost        $0.0412
```

Flags: `--limit=N` (first N cases, for a cheap smoke), `--out=path` (JSON
report), `--min=0.8` (exit 1 below that, for CI).

The number to compare is the **mean**. Pass rate is coarser by design — a case
passes at 0.8, so a run that loses every link but keeps every decision still
scores 0.5 a case and passes nothing, which is the shape of regression the mean
shows earliest.

## How a case is scored

    score = 0.5 × (decision matched) + 0.5 × (F1 over the link set)

Three decisions — `task`, `link`, `leave` — and links restricted to the
projects and goals in a fixed fictional snapshot.

**Half each**, because the two failures are differently bad in ways that cancel
out. Calling a passing remark a task puts work in front of you that you never
agreed to; linking it to the wrong project quietly changes what the scorer
surfaces tomorrow. Weighting one over the other would be a claim these thirty
cases cannot support.

**F1 rather than exact set match**, so a partly-right answer scores partly
right. The one case expecting two links that finds one of them is meaningfully
better than the one that finds neither, and exact match calls them equal. For
every `leave` case both sets are empty, F1 is 1 by definition, and the case
turns entirely on the decision.

**An unparseable reply scores zero.** The frame asks for JSON and nothing else;
the parser tolerates a code fence and surrounding prose, and beyond that gives
up. That is not a formatting quibble — the same failure in the nightly run is an
agent that has started narrating instead of filing.

### Two collapses worth knowing about

The agent's prompt offers four outcomes; the dataset grades three. "A note worth
keeping" and "nothing" are the same _action_ — leave the thought alone — and
differ only in the agent's private opinion of the thought's worth. Grading a
distinction with no consequence measures vocabulary, not behaviour.

Links are **projects and goals only**. A wrong project link changes what you are
shown tomorrow morning; a missing person link changes nothing anyone sees, and
grading it would add noise to the number that is supposed to answer one
question.

### The expected answers are a judgement

Every case carries a `note` giving the reasoning, so that when a case starts
failing you can decide whether the agent got worse or the case was always wrong.
Several cases expect `leave` for thoughts a generous reading would file
somewhere — `bus-factor-worry`, `ambient-market-note`. That is rule 5 of the
triage prompt ("skip what you cannot classify confidently") asserted rather than
assumed, and it is the dataset's deliberate bias: an untouched inbox item costs
nothing, a wrongly-filed one is invisible until you go looking.

Disagree with a case? Change it. Then note that the mean before and after are no
longer comparable — which the seed makes visible, because the content hash is
in the dataset's name.

## Why a script and not a batch run

Two reasons. The second is the load-bearing one.

**1. The grader is not in the worker's registry, and cannot be.**
`registerGrader` writes to a module-scoped `Map`; core's batch worker runs in
the route realm (`…/maintenance/tick`), which shares no module graph with
`instrumentation.ts`. There is no `lib/app/*` seam for a fork's grader, so there
is nowhere to put a registration the worker would see — ask #33 in
[`resparkable-asks.md`](./resparkable-asks.md) →
[resparkable#541](https://github.com/human-centric-engineering/sunrise/issues/541).
Registering from `initResparkable()` would
fill a map nothing reads and would look like wiring, so `registerResparkableGraders()`
is exported and left uncalled at boot; the script calls it and dispatches through
core's registry exactly as the worker would.

**2. The subject writes.** `resparkable-triage` is bound to tools that create tasks
and assert links — that is what it is for — and a batch run queued from the
admin UI executes it **as whoever queued it, against their own brain**. The
script instead creates a throwaway user for the run and deletes it afterwards,
so anything the agent writes goes with it through the D1 cascade.

Every case says plainly that the snapshot exists in no brain, which is what
keeps a helpful model off the tools in the first place. The script reports every
tool call it saw anyway:

```
  ⚠ 2 case(s) called tools despite being told not to:
      chase-invoice: resparkable_search
```

That is a finding about the nightly run even when the classification underneath
it was right — and the nightly run has no scratch user to hide behind.

### If you do queue it from the admin UI

The dataset is seeded, so you can. Know what you are pointing at: use a scratch
account, or accept that `resparkable_upsert_task` may leave a real task behind
(`resparkable_promote_thought` and `resparkable_link_entities` cannot — every id in the
cases is invented, so owner-scoped lookup finds no row). Core's graders —
`json_schema`, `judge_agent` — work on the dataset today; `resparkable_triage_accuracy`
does not appear in the metric picker until ask #33 lands.

## The dataset in the database

Seeded as `Resparkable — triage accuracy (<hash>)`, unowned, thirty cases.

**A changed case set is a new dataset, not an edited one.**
`AiEvaluationCaseResult.datasetCase` has no `onDelete`, so it is `Restrict`: the
moment anyone has run the dataset once, deleting its cases throws, and the seed
starts failing on exactly the installations that used the feature. So the
content hash goes in the name and each distinct case set gets its own row. Past
runs keep the cases they actually scored, and comparing across a revision is
visibly comparing two datasets rather than invisibly comparing two meanings of
one. Superseded revisions that nothing references are removed on the next seed;
one with runs or experiments against it is a record, and stays.

## See also

- [`agents.md`](./agents.md) — what `resparkable-triage` may and may not do, and why
  the bindings rather than the prompt are what hold
- [`.context/orchestration/evaluations.md`](../../orchestration/evaluations.md) —
  core's batch-run architecture, the grader registry, agents-as-judges
