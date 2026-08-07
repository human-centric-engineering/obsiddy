# Design language — "amber phosphor on volcanic glass"

Resparkable's visual system: what it is, where each part lives, and the rules that
keep it coherent when someone adds a screen next month.

Read this before styling anything. The one-line version: **almost nothing is
styled per-component** — the look comes from ~40 lines of CSS custom properties
in one file, and the fastest way to break it is to hardcode a colour.

**See also:** [`surface-theming.md`](./surface-theming.md) for the `data-surface`
mechanism this builds on · [`components.md`](./components.md) for the shadcn/ui
primitives · [`contextual-help.md`](./contextual-help.md) for `<FieldHelp>`.

---

## The idea

The name is the brief. Obsidian is volcanic glass: black, cold, and _sharp_ — it
fractures conchoidally, into edges rather than curves, which is why it made the
first blades. But it was lava an hour ago, and a good specimen still catches
light along a fracture.

That gives three commitments the whole system follows from:

| Commitment                      | What it means in the UI                                                       |
| ------------------------------- | ----------------------------------------------------------------------------- |
| **The base is glass, not soot** | Near-black with a blue-violet cast (`#0a0b0f`), never `#000`                  |
| **Geometry fractures**          | Every radius roughly halved against Tailwind's defaults — 4px where it was 6  |
| **One accent, used sparingly**  | Ember amber (dark) / indigo (light), only where something is live or selected |

And one product commitment underneath them: **the chrome is an instrument, the
content is a page.** The shell around your notes reads like a terminal. The notes
themselves read like something a person wrote. That distinction is what the
three-font split exists to serve, and it is the rule most likely to be broken by
accident.

### Why amber and not terminal green

Everyone reaches for green when they want "terminal". Amber CRTs were the ones
people chose when they had to read all day — lower flicker perception, warmer
adaptation. This is an app you keep open, so it takes the phosphor that was
picked for endurance rather than the one that reads as retro.

### Why the accent is indigo in light mode

**This is the only token whose hue depends on the mode, and it is a constraint
before it is a choice.** Amber is a light colour: `#f5a524` is 1.9:1 on white —
invisible. Dragging it down to AA lands around `#b45309`, and _any_ warm
yellow-orange dark enough to pass on paper reads as **brown**. There is no amber
that is both legible on white and still amber. Light mode ran rust for a while
and looked like a filing cabinet.

Indigo-700 `#4338ca` is what it runs on instead — 7.9:1 on a white card, so it
carries link text as well as filling a button, which stops it needing a second
readable hue beside it. Deep enough to read as an instrument rather than the
lavender every AI product reached for, and blue enough not to be confused with
the violet `--color-sheen` reserves.

Dark stays on the ember. Two faces of one material, not two brands: the glass
with the heat still in it, and the same glass in daylight.

**The neutrals move with the accent, every time.** They were warm for the amber,
then faintly green for a teal that didn't survive review, and are now a whisper
of the indigo. A page whose greys disagree with its buttons reads as beige (warm
under cool) or as dirty (green under indigo). This is the step that gets
forgotten when a primary is re-pointed.

---

## Where things live

Four files, and the split between them is not cosmetic — it follows what Tailwind
can and cannot do at runtime.

| File                         | Owns                                                         | Why there                                                                        |
| ---------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `app/globals.css` → `@theme` | Token _declarations_: font keys, signal colours              | Tailwind reads `@theme` at **build** time to decide which utilities exist        |
| `app/brand-theme.css`        | Token _values_: palette, radii, atmosphere, composed classes | Fork-owned seam; upstream never edits it, so a Resparkable upgrade can't collide |
| `app/layout.tsx`             | `next/font` loading, `--font-resparkable-*` on `<html>`      | Only place `next/font` can go                                                    |
| `lib/app/surface.ts`         | Which URLs are `admin` vs `consumer`                         | Shared by `proxy.ts` and `<SurfaceSync>` so the two can't drift                  |

The rule to remember: **a runtime variable can restyle a utility, but it cannot
bring one into being.** `--color-primary` can be re-pointed in `brand-theme.css`
and every `bg-primary` in the app follows. A brand-new `--color-signal` has to be
declared in `@theme` or `text-signal` never gets generated.

---

## Typography — three families, three jobs

Loaded in `app/layout.tsx`, exposed as `font-display` / `font-sans` / `font-mono`.

| Utility        | Family             | Job                                                                    |
| -------------- | ------------------ | ---------------------------------------------------------------------- |
| `font-display` | **Martian Mono**   | `h1`/`h2`, the wordmark, `.term-label`. **Short strings only.**        |
| `font-mono`    | **JetBrains Mono** | Data: ids, paths, timestamps, counts, code, the capture prompt         |
| `font-sans`    | **Archivo**        | Body copy and note content. The default — you rarely write this class. |

`h1` and `h2` get the display font automatically. `h3` and below deliberately do
**not**: they sit inside cards next to body copy, and a monospace `h3` two lines
above a paragraph makes the paragraph look like a mistake.

**Do not set a whole UI in monospace.** It looks right in a screenshot and is
tiring to read a paragraph in. That is the failure mode of this entire genre.

### The 11px floor

`.term-label` is 11px, and that is a floor rather than a preference. Uppercase
costs the ascender and descender cues that make lowercase scannable, so tracking
has to buy them back (`+0.14em`) — and the size cannot _also_ be shaved. **10px
uppercase tracked text is the single most common readability failure in this
aesthetic**, and the codebase had 168 instances of it before this system landed.

Nothing in the app should be below `text-[11px]`. Body text is 16px, not the 14px
that dense "pro tool" UIs drift toward: density is worth having right up until the
moment it costs you a re-read.

---

## Colour

### Semantic tokens (re-skin everything)

The standard shadcn set — `background`, `foreground`, `card`, `popover`,
`primary`, `secondary`, `muted`, `accent`, `destructive`, `border`, `input`,
`ring` — each with a light and dark value in `brand-theme.css`.

Two details worth knowing:

- **Surfaces climb in ~2% steps** (`background` → `card` → `popover` → `input`)
  so elevation is legible without a single shadow. Shadows are dishonest in the
  dark anyway; they show up as smudges.
- **`border` and `input` are different on purpose.** `border` is the structural
  line you are meant to see; `input` is a shade brighter because a field has to
  advertise that it is a field before you click it.

`muted-foreground` runs at **6.0:1 (light) / 7.6:1 (dark)**, not the ~3.5:1 that
"subtle grey" usually lands on. It is the most-used colour in the app — every
timestamp, count and blurb — and secondary text you have to lean in for is text
nobody reads.

### Every box that holds content has a surface

**A bordered container with padding gets `bg-card`. No exceptions, and this is not
a style preference — it is load-bearing.**

Chips, pills, swatches and toggles stay transparent; they sit _on_ something and
are read as marks, not containers. The rule is about boxes with content inside.

This was invisible debt for the whole life of the codebase. Resparkable's light
palette set `--color-background: #ffffff` **and** `--color-card: #ffffff` — the
same value — so a bordered box that forgot `bg-card` rendered identically to one
that had it. 158 containers across `components/` and `app/` had quietly omitted
it. The moment the page background stopped being card-white and grew a grid, all
158 went see-through at once and the app looked half-finished.

Two lessons worth keeping:

- **Identical token values hide missing tokens.** If two semantic colours happen
  to be equal, every place that confuses them is a latent bug waiting for one of
  them to move. It is worth keeping `background` and `card` visibly distinct for
  that reason alone.
- **A page background with texture is a correctness constraint, not decoration.**
  `.obsidian-field` means anything without a surface leaks the grid. That is a
  feature — it makes the omission obvious instead of invisible — but it means new
  containers must say `bg-card` from the start.

### Signal colours (never re-skinned)

`text-signal` · `text-info` · `text-warn` · `text-sheen`

Deliberately separate from `primary`: primary is the brand's voice and gets
re-pointed per surface. These four are **meanings** and must not move when the
brand does — a live indicator that turned amber because someone rebranded would
be a lie.

`--color-sheen` (violet) is the one exception to "one accent", and it is
reserved: **only ever where the machine is thinking on your behalf** — the
sidekick, streaming responses, AI suggestions. Rainbow obsidian shows a violet
sheen when light catches a fracture; this is the app's equivalent. Use it
anywhere else and it stops meaning anything.

**`--color-sheen` is the one to watch when the primary moves.** In light mode it
is pushed most of the way to fuchsia (`#a21caf`) rather than the violet it uses
in dark, because violet beside indigo is a distinction nobody makes at a glance
— and a signal that could be mistaken for a slightly-off primary has stopped
being a signal. The same trap caught `--color-signal` while the primary was
teal, and emerald had to go yellow-green for a while. Check every signal against
the primary whenever the primary changes.

### The `/admin` shift

`proxy.ts` classifies each request through `classifySurface()`; the root layout
puts the answer on `<html data-surface>`. Resparkable uses that for exactly one
distinction: **the back office runs on teal.**

This is not decoration. `/admin` is where you change things for everybody, and
the most useful thing the UI can do is make it impossible to think you are still
in your own notes. A colour shift is read pre-attentively, before any label is.

**This block has been re-pointed twice, both times because the consumer accent
moved, and that is the part worth remembering.** It was cyan against a rust
consumer; when consumer light went teal the two sat ~24° apart, and when it went
indigo the blue that had replaced the cyan sat ~21° from _that_. Neither was
wrong on its own; both quietly stopped doing the one job this shift has.

**If you re-point the consumer accent, check this pair again — roughly 60° of hue
separation is the floor.** A surface-distinguishing colour that no longer
distinguishes is worse than none, because it is still claiming to.

Unlike consumer, admin keeps one hue across both modes (teal-700 on paper,
teal-400 on glass). The back office has no brand story to tell; it needs to be
unmistakably not-your-notes in whichever mode you are in, and nothing more.

The admin block declares **deltas only** (`primary`, `ring`, `--obs-bloom`).
Everything else is inherited, so a palette edit reaches admin too and the two
surfaces can never drift into being two products.

---

## Geometry

```
--radius-xs: 1px    --radius-sm: 2px    --radius-md: 4px
--radius-lg: 6px    --radius-xl: 8px    --radius-2xl: 12px
```

Components never ask for a radius by name — they say `rounded-md` — so
re-pointing five variables re-cuts every card, button, input, dialog and popover
at once.

`rounded-full` is left alone. Dots, avatars and count pills are the places where
a circle means something, and they read better for being the only curves in the
room.

---

## The composed classes

All in `@layer components`, so a Tailwind utility on the same element still wins.

| Class               | Use for                                                                            |
| ------------------- | ---------------------------------------------------------------------------------- |
| `.term-label`       | Naming a region without spending a heading on it — nav groups, column heads        |
| `.term-meta`        | The same job in a quieter voice, for labels that repeat once per row               |
| `.term-rule`        | A dashed divider _within_ a panel, where a solid border would imply false nesting  |
| `.obsidian-field`   | The page background. Replaces `bg-background` on layout roots                      |
| `.obsidian-chrome`  | Sticky header / rail glass — blur + saturation + a 1px top highlight               |
| `.live-edge`        | **"This one is live."** A 2px lit bar hard against the left edge                   |
| `.obsidian-reveal`  | One 12px rise-and-fade, on first paint only                                        |
| `.terminal-surface` | **Where the machine talks** — chat, capture box, briefing. Mono for the subtree    |
| `.spark-lit`        | The lit syllable of the wordmark — the accent plus a halo that only shows on glass |

### `.terminal-surface`

The one place the "chrome is an instrument, content is a page" rule is
deliberately suspended, and the exception has a principle behind it: Archivo is
for prose _a person wrote_. Chat output, the morning briefing and the prompt you
type are a session with a program, not a document — and a session should look
like one.

Apply it at the **call site**, never inside `MarkdownView` — that component
renders assistant replies _and_ notes you typed by hand. Same renderer, different
voice, decided by who is speaking. See
[`framework/resparkable/ui.md` §12](../framework/resparkable/ui.md) for the per-surface
table.

The class carries `line-height: 1.7` for a reason: identical glyph widths strip
the word _shapes_ that carry the eye across a sans paragraph, so the return sweep
needs more leading to land. It deliberately does **not** set a max-width —
callers own their measure, and a monospace column wants a narrower one than sans.
If you apply this to something full-bleed, cap the line length yourself.

### `.obsidian-field`

A 48px grid at ~4% opacity with a single warm bloom top-left. The grid does real
work rather than being texture: it gives the eye a reference for the alignment
everything else is built on, so the layout reads as deliberate rather than merely
tidy. At this contrast it lands as depth, not pattern — you notice it when it is
removed, not when it is there.

`background-attachment: fixed` keeps it still while content scrolls over it, which
is what sells it as a surface. Dropped on touch devices, where fixed attachment is
both expensive and unsupported.

### `.live-edge` — the scarcity rule

Reserved for the current item: the active nav row, the selected card, the
streaming message. **The whole colour strategy is one accent against a quiet
field, and it stops working the moment two things glow.** If you are reaching for
it a second time on the same screen, one of the two is not actually "current".

It draws in `--color-primary`, whatever that currently is — so it is amber in
dark, indigo in light, teal on `/admin`, with no variant logic at the call site.
That is also why it is no longer called `.ember-edge`: the name was describing a
colour the class only has in half the app.

### `.spark-lit` — the one exception to "no glow"

The middle syllable of `re·spark·able`, and the only part of the wordmark
carrying the accent — `re` and `able` are the quiet field it sits in, which is
what keeps a three-colour logo inside the one-accent rule.

The halo draws in **`--obs-bloom`**, the same wash `.obsidian-field` puts in the
corner of the page, rather than a literal amber. That is what makes it
mode-correct without a `.dark` variant: on glass the token is the ember at 9% and
the glow reads; on paper it is indigo at 4.5% and the glow is effectively absent.
**The asymmetry is the point** — a halo on a white page does not read as light,
it reads as a printing fault, which is the same reason light mode has no accent
glow anywhere else.

It is not `.live-edge` and does not spend its scarcity: a wordmark is not a claim
that something is current. If you need a second glowing thing on a screen that
already has a `.live-edge`, this is still not it.

---

## Motion

One orchestrated arrival — `.obsidian-reveal`, a 12px rise and fade — and
essentially nothing else. It says the app assembled itself, then gets out of the
way. Stagger via inline `animation-delay` on the caller, so nothing has to be told
how many siblings it has.

**Never put it on something that re-renders often.** A card that fades in every
time a count changes is a bug wearing a costume.

Everything motion-related is behind `prefers-reduced-motion`, and nothing carries
meaning that only the animation conveys.

---

## Adding a screen: the checklist

1. **Use semantic tokens.** `bg-card`, `text-muted-foreground`, `border-border`.
   Never a raw hex, never `bg-slate-800`. A hardcoded colour is a screen that
   won't follow a theme toggle, a palette change, or the `/admin` shift.
2. **Every bordered box with content in it gets `bg-card`.** Chips and swatches
   don't. A container with no surface leaks the page grid — see above.
3. **Nothing below `text-[11px]`.** Reach for `.term-label` / `.term-meta` first
   — they exist so the decision is already made.
4. **`h1`/`h2` for real headings only** — they carry the display font, and a
   Martian Mono `h2` on a string of any length will sprawl.
5. **`.live-edge` at most once per screen.**
6. **Mono for data, sans for prose.** Ids, paths, timestamps and counts get
   `font-mono` (and `tabular-nums`, which the body already sets globally so
   columns of numbers don't wobble). Sentences get the default.
7. **Check both modes and both surfaces.** The theme toggle is real, and half of
   thinking work happens in a bright room.

---

## The cascade rule (read before editing `brand-theme.css`)

The token blocks are **unlayered** and must stay that way. Tailwind emits its
`@theme` tokens inside the `theme` cascade layer, and an unlayered declaration
beats _any_ layered one regardless of specificity. That is what lets ~40 lines
re-skin several hundred components without touching one of them.

The corollary is a trap. Because unlayered wins on layer and not on specificity,
a `:root` block here also beats `globals.css`'s `.dark` block. So:

- Each block declares the **full** token set, not a delta.
- Dark is pinned at higher specificity (`:root.dark`, 0-2-0) than light
  (`:root`, 0-1-0); the admin deltas are one step above each, and come last.

**Add a token to one block and you must add it to the other**, or dark mode
silently inherits a light value. This is the single most likely way to break the
theme, and nothing will fail loudly when you do.

Verify a change landed by checking the compiled layer order — `properties`,
`theme`, `base`, `components`, `utilities`, with the unlayered brand blocks after
all of them.
