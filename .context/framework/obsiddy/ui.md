# Obsiddy UI — the rules, and why each one exists

Everything under `app/(protected)/obsiddy/**` and `components/obsiddy/**`.

Read this before adding a surface. Every rule below is here because breaking it
produces a page that looks correct.

---

## 1. One enriched fetch per surface. Never one per row.

`CLAUDE.md` forbids per-row client fetches, and a second brain is where that rule
earns its keep: a dashboard of ranked tasks, each needing a project, each project
needing an area, is thirty requests and a page that assembles itself in front of
the user.

Every surface therefore has **one endpoint that returns everything it renders**:

| Surface     | Endpoint                      |
| ----------- | ----------------------------- |
| Today       | `/obsiddy/today`              |
| Inbox       | `/obsiddy/inbox`              |
| Project     | `/obsiddy/projects/[id]/view` |
| Person      | `/obsiddy/entities/[id]/view` |
| Card sheet  | `/obsiddy/tasks/[id]/view`    |
| Board       | `/obsiddy/boards/[id]/view`   |
| Connections | `/obsiddy/connections`        |
| Graph       | `/obsiddy/graph`              |
| Nav badges  | `/obsiddy/counts`             |

**The query count must not move with the row count.** The route tests assert the
count directly, because an N+1 regression changes nothing you can see. If a new
field needs a query per row, batch it in the service — `hydrateLinks` and
`listTagsForTasks` are the shape to copy: collect ids across the whole batch,
then one query per type.

A page may issue **two or three** fetches for _page-level_ things — the option
list for a select, the tag library — as long as none is per row. Run them
concurrently.

## 2. Server components read. Client components mutate.

```
page.tsx (server)  → readObsiddy(OBSIDDY_API.X, schema) → pass `initial` down
view.tsx (client)  → apiClient.patch(...) → optimistic update
                   → SaveStatus (aria-live) → router.refresh()
```

**Pages read through the API, not through the services.** A server component
could call `buildToday(ownerScope(session.user.id))` directly and save a
localhost round trip. It doesn't, because that would create a second
implementation of "what does this surface show" — and the API is the contract the
agent layer and MCP will use too. One path, exercised by everything.

Failure is a **state**, not an exception: `readObsiddy` returns a result, pages
render `<LoadError>`, and a failed option-list read degrades one dropdown rather
than taking down the page.

## 3. Wire shapes are parsed, never cast.

`lib/framework/obsiddy/ui/payloads.ts` describes what arrives **after**
`JSON.stringify` — every `Date` is a string, every `undefined` is gone. A
component typed with a service's return type would be lying, and the lie surfaces
at runtime as `dueAt.getTime is not a function` rather than as a type error.

The schemas are deliberately **not** `.strict()`. During a rolling deploy the API
is briefly ahead of the client, and an unknown field must not blank a page.

## 4. Optimistic where it matters, with a real rollback.

Ticking a task, dragging a card, accepting a suggestion, capturing a thought.
Waiting on a round trip before the screen changes makes these feel broken.

Two rules:

- **Capture the previous state before the optimistic update, restore it
  wholesale on failure.** A partial rollback is how a board ends up disagreeing
  with the server in a way nobody notices until a refresh.
- **Never lose user input.** `QuickCapture` clears the textarea immediately and
  puts the text _back_ if the POST fails. That is the one unforgivable failure in
  this product.

## 5. Missing primitives are built here, not installed.

Sunrise ships no toast, skeleton, progress bar or generic data table, and Obsiddy
deliberately adds none (`plan.md` §9):

| Need     | Instead                                                               |
| -------- | --------------------------------------------------------------------- |
| Toast    | `ui/save-status.tsx` — an `aria-live` status line next to the control |
| Skeleton | `ui/skeleton.tsx` — `animate-pulse` divs                              |
| Progress | `ui/progress-bar.tsx` — `role="progressbar"`                          |
| Table    | `components/ui/table.tsx` primitives, per surface                     |
| Radio    | `Select`                                                              |
| "Now"    | `ui/use-now.tsx` — see below                                          |

Three dependencies were added, all pre-approved: `d3-force` (graph layout),
`@dnd-kit/core` and `@dnd-kit/sortable` (the board, and the only reason it is
keyboard-operable).

## 6. Never read the clock during render.

`Date.now()` in a render body breaks `react-hooks/purity` **and** lets the server
and the browser disagree about what is overdue. Use `useNow()`: it returns `null`
until mounted, and callers treat `null` as "not yet known".

Err toward the neutral state — a task briefly _not_ flagged overdue is better
than one briefly flagged wrongly.

## 7. Say the thing that is otherwise invisible.

Several of this product's behaviours are silent when they misfire. The UI names
them, and these strings are not decoration:

- **An area with no weekly target does not participate in `areaBalance` at all.**
  It looks configured; the term is simply off for it.
- **Targets summing past your weekly capacity** make every area read as
  neglected, flattening the factor rather than sharpening it.
- **A sweep that hit its cap** looks exactly like a sweep that found everything.
  `cappedTypes` is rendered prominently; so is the graph's `truncated`.
- **An expired pin** stops applying. `PriorityExplainer` reports
  `priorityFactors` verbatim and recomputes nothing — an expired boost arrives as
  `manualBoost: 0` with `boostActive: false`.
- **Archived items are keyword-searchable, not meaning-searchable**, because
  archiving deletes their embeddings.
- **A restored item** returns to meaning-search only after the next indexing pass.
- **Card aging names its own measurement.** "9d in Doing" is read from the card's
  last status-change event; "untouched 11d" is the fallback when there is no such
  event to read (a card never moved, or moved before that metadata existed). The two
  are worded differently on purpose — see `plan.md` §12's phase 5 note.

## 8. Accessibility rules that are easy to skip

- **Icon-only buttons need an `aria-label` that names the subject**, not just the
  verb: "Snooze this task", not "Snooze". These sit one per row.
- **Never nest a popover inside a dropdown menu.** Two focus traps, one inside
  the other; the inner field loses focus to the outer menu's typeahead. Make it a
  sibling control — `SnoozeMenu` does.
- **Never nest an interactive control inside a drag source.** Every click starts
  a drag first. The board's "Open" button sits outside the drag listeners.
- **A column must be its own drop target.** An empty column has no sortable
  children, so without `useDroppable` on the column a card can never enter an
  empty status — the first thing anyone does with a new board.

## 9. Forms

`react-hook-form` + Zod resolver, `mode: 'onTouched'`, and `<FieldHelp>` on every
non-trivial field. The dialog shell is `ui/resource-dialog.tsx`; **the caller owns
`useForm`** (a component generic over "some Zod schema" loses the input/output
relationship `zodResolver` needs, and the only escape is an `as`).

`toBody` stays per-form. The API schemas are `.strict()`, so "omit the field" and
"send null" are different requests — one leaves a value alone, the other clears
it — and only the form knows which an empty input means.

Help text says **what the field does to the system**, not what it is. "Which
domain of your life this belongs to" is a definition; "a neglected area floats its
work up your list, and this is 15% of every task's score" is the reason someone
would fill it in.

---

## Adding a surface — the checklist

1. Does an endpoint return **everything** the page renders? If not, add a `/view`
   sibling and a service that batches. Assert the query count.
2. Add its wire schema to `ui/payloads.ts`.
3. Server page: `readObsiddy` → `<LoadError>` on failure → pass `initial` down.
4. Add the route to `OBSIDDY_ROUTES` and, if it deserves one, a nav entry.
5. Add a `loading.tsx` using `SkeletonList`.
6. Component tests for the behaviour that would look fine if wrong — optimistic
   rollback, request shape, and the copy that explains a silent behaviour.
