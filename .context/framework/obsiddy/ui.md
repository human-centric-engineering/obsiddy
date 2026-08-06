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
  this product. It is also why the capture drawer is parked off-screen rather
  than unmounted when it closes (§10) — a stray click must not be able to bin a
  half-written thought.

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

## 10. The capture sidekick

`components/obsiddy/layout/obsiddy-sidekick.tsx` — a fixed, full-height drawer
rendered by the Obsiddy shell, not a column in it.

**It overlays; it never narrows the page.** It used to be an 18rem card in a
two-column grid, which cost every surface a fifth of its width permanently in
exchange for a two-row textarea — the wrong trade twice over, since the board,
the graph and the planner are all width-hungry and two rows is not room to think
in. Opening the drawer now reflows nothing underneath.

**Closing parks it, it does not unmount it** (`inert` + `translate-x-full`). See
§4: the textarea's contents, an attached file and an in-flight transcript all
survive being clicked away from.

**Pointing anywhere else closes it, and that click still lands.** No backdrop
above `sm`, no focus trap, no `preventDefault` on the outside click — a
dismissing overlay that swallows the first click is what makes a drawer feel
like an obstacle. The listener is on `pointerdown` rather than `click` so that
releasing the resize drag past the page edge does not close it.

**Three ways in, one destination.** Typing, dictating (`voice-capture-button.tsx`)
and dropping a file (`capture-attachment.tsx`) all end in the same textarea. None
of them posts anything on its own: dictation mishears, extracted document text
needs cutting down, and both stay drafts until a person presses Capture. That is
what makes it safe for the easy paths to be this easy.

**A dropped file asks where it goes, and is never guessed at.** Two endpoints,
because they are two different promises:

| Choice            | Endpoint                     | What happens                                  |
| ----------------- | ---------------------------- | --------------------------------------------- |
| Read into capture | `/obsiddy/documents/extract` | Parsed, text returned, **nothing stored**     |
| Add to Documents  | `/obsiddy/documents`         | Hashed, deduped, embedded, searchable forever |

Guessing is a bad trade in both directions: guess "read" and the report someone
meant to keep is gone; guess "file" and their library fills with attachments they
only wanted to glance at. Extraction is capped at 20 000 characters and reports
`characters`/`truncated` for the whole document, so the UI can say what it left
out rather than passing off a third of a book as the whole thing.

**Voice reuses the platform's machinery but not its route or its component.**
`useVoiceRecording` and `MicLevelMeter` are imported as-is; `MicButton` is not,
because it requires an `agentId` and posts it, and the platform's transcribe
endpoint is `withAdminAuth`. `/obsiddy/transcribe` resolves the companion agent
server-side for cost attribution only, and gates on the org-wide
`voiceInputGloballyEnabled` kill switch but **not** on any agent's
`enableVoiceInput` — that flag governs an agent's chat surface, and this
microphone addresses no agent.

---

## 11. The section nav

`components/obsiddy/layout/obsiddy-nav.tsx` — a grouped rail down the left of the
shell, not a row of pills across the top.

**Fourteen equal-weight pills is a list nobody has named.** Wrapped onto two
rows, every item looked equally likely, so finding one was a linear scan of
fourteen words — and the second row pushed the page's own heading below the fold
on a laptop. The four groups (**Daily**, **Organise**, **Knowledge**,
**Manage**) are the product's model, so a scan is four short lists, and a section
added next month joins a group instead of starting a third row.

**Vertical is the axis these pages have to spare.** The rail costs 224px of a
width nothing was using and returns the height everything was using. It collapses
to icons for the surfaces that want the width back — Graph, Boards — and the
choice persists under `obsiddy.nav.collapsed.v1`.

**Both the rail and the small-screen switcher are always rendered**, one hidden
by a media query. No JS branch on viewport, so nothing shifts on hydration. It
also means jsdom sees both: nav tests scope to
`getByRole('navigation', { name: 'Obsiddy sections' })`, or a badge in the tree
twice reads as a badge on screen twice.

**`OBSIDDY_NAV_ITEMS` is derived from `OBSIDDY_NAV_GROUPS`**, never hand-kept
alongside it. `section-help.test.ts` asserts every entry in the flat list has help
copy; a second hand-maintained list is how a section would end up in the nav and
outside that check.

**Counts sit in a right-aligned column.** "What is waiting on me" should be one
downward glance. Collapsed, the number becomes a dot for sighted users and stays
a number in `sr-only` text — a link named `7 waiting` with no section name is
worse than no badge.

**The shell prints one title, and it is the section's.** `<SectionHeader>` owns
the `h1`. The word "Obsiddy" survives once, in the rail head, where it is also
the way home — the app nav says it too, and the old product tagline under the
old `h1` restated the section blurb one line below it.

---

## 12. Machine output is monospaced. Yours is not.

Anywhere the app is _talking to you_ — the chat transcript, the morning briefing
— and the prompt you type into it get `.terminal-surface`
([design-language.md](../../ui/design-language.md)), which switches the subtree to
JetBrains Mono and gives it the leading monospace needs at reading length.

**The line is who wrote it, not which component renders it.** `<MarkdownView>`
renders both an assistant reply and a note you typed, so the class goes on the
**call site**, never inside the component. Put it in `MarkdownView` and every
project description in the product turns into a terminal.

| Surface                       | Treatment                                                         |
| ----------------------------- | ----------------------------------------------------------------- |
| Chat transcript + composer    | `.terminal-surface` on the root — the whole exchange is a session |
| Capture box                   | `.terminal-surface` on the `<Textarea>` only                      |
| Morning briefing title + body | `.terminal-surface` on the prose, not the card                    |
| Thoughts, notes, descriptions | **Nothing** — this is your writing, it stays in Archivo           |

Scope it as tightly as the meaning goes. On capture that means the box and not
the form: what you type into a terminal is monospaced, the panel around it isn't,
and the attachment card and status notes below are the app addressing you. On the
briefing it means the two paragraphs the overnight workflow wrote — the staleness
warning above them is the app's own voice.

The admin orchestration chat
(`components/admin/orchestration/chat/chat-interface.tsx`) arrived at the same
treatment independently and still carries its own `font-mono`; it is
Sunrise-owned, so it is left alone rather than converted.

Streaming output ends in a `.terminal-caret` — the blinking block says the
program has the line and has not finished with it, which is the only thing you
want to know while waiting. It stops blinking under `prefers-reduced-motion`, and
the word beside it carries the meaning on its own.

---

## 13. The chat is one panel, and the wait explains itself

**One border around the transcript and the composer, with a divider between
them.** The exchange is a single object: the thing you type into is the bottom of
the thing you are reading, and a gap with the page showing through says
otherwise. `overflow-hidden` on the panel is what lets its corners clip the
scrolling transcript inside.

**The user's turn is a bubble; the assistant's is not.** Two near-identical greys
stacked down a transcript is a weaker signal than shape and alignment, and the
reply should read as the page rather than as a quote on it. A rule down the left
marks it as spoken by the app.

### Streaming is paced, not raw

The stream was always token-by-token, but providers send whatever their own
buffering produces — often a whole clause — so raw rendering arrives in slabs:
technically streaming, visually a series of jumps.

`useTypingAnimation` (`lib/hooks/` — platform-level, so the tier may import it,
unlike anything under `components/admin/`) sits between the deltas and the DOM
and releases the buffer at a fixed rate per frame. Two rules:

- **State holds the whole answer; the hook holds how much may be shown.** The
  renderer prefers `typing.displayText` for the last assistant turn while
  `streaming || typing.isAnimating`, then hands over to the settled message with
  no visible change.
- **Never `flush()` on the happy path.** The stream finishing is not the same
  event as the answer finishing being read; cutting the reveal short at `done`
  makes the last sentence of every reply snap into place. Flush and `reset()` are
  for `content_reset`, rollback, and teardown.

It is a paced reveal of text already received — nothing extra on the wire, and it
can never show a token the server did not send. Disabled under
`prefers-reduced-motion`: that preference asks for the content, not the
performance of it arriving.

### The wait says what it is doing

`<ThinkingIndicator>` renders while the live turn has no text yet — dots plus the
handler's own status string ("searching your brain"). A static word during a
ten-second tool call is indistinguishable from a hung page.

Status arriving _mid-answer_ gets a separate `aria-live` line, rendered only when
the indicator is not on screen. Two live regions carrying the same string
announce the event twice.

### Composer

`<AutoGrowTextarea>` (`components/obsiddy/ui/`) — one row when empty, grows to
ten, scrolls past that. It measures `scrollHeight` after collapsing to `auto`
rather than counting newlines, because soft wrap makes counting wrong on a narrow
box. It also sets `min-h-0`: the base `<Textarea>` ships `min-h-[60px]`, and
`min-height` constrains `height` rather than losing to it.

Dictation reuses `<VoiceCaptureButton>` and lands the transcript **in the box**
rather than sending it — a transcript with a wrong word in it should be fixable
before it is asked.

---

## Adding a surface — the checklist

1. Does an endpoint return **everything** the page renders? If not, add a `/view`
   sibling and a service that batches. Assert the query count.
2. Add its wire schema to `ui/payloads.ts`.
3. Server page: `readObsiddy` → `<LoadError>` on failure → pass `initial` down.
4. Add the route to `OBSIDDY_ROUTES` and, if it deserves one, a nav entry — into
   a group in `OBSIDDY_NAV_GROUPS`, and a matching entry in `ui/section-help.ts`
   or its test fails.
5. Add a `loading.tsx` using `SkeletonList`.
6. Component tests for the behaviour that would look fine if wrong — optimistic
   rollback, request shape, and the copy that explains a silent behaviour.
