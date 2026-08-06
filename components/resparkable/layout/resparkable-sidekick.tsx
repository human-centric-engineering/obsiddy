'use client';

/**
 * ResparkableSidekick — the full-height capture drawer that rides alongside every
 * Resparkable page.
 *
 * ## Why it overlays instead of taking a column
 *
 * It used to be an 18rem card in a two-column grid, which cost every page a fifth
 * of its width permanently in exchange for a two-row textarea. That is the wrong
 * trade twice over: the board, the graph and the day planner are all width-hungry
 * surfaces being squeezed by a control nobody is using most of the time, and when
 * you *are* using it, two rows is not enough room to think in.
 *
 * So the panel is `fixed` and the page beneath it is full width. Opening the
 * drawer changes nothing about the layout underneath — no reflow, no column
 * collapse, no board re-wrapping mid-drag. It slides over, you write, it slides
 * back.
 *
 * ## Why it is not modal, but does get out of the way
 *
 * A sidekick you can only use with the rest of the app frozen is a dialog wearing
 * a different shape. There is no focus trap and, above `sm`, no backdrop: you can
 * read the project you are writing about while you write about it, and the panel
 * stays put across navigations because it is state, not a moment.
 *
 * Pointing at anything else closes it, and — this is the part worth keeping — the
 * click still reaches whatever you pointed at. A dismissing overlay that eats the
 * first click is the thing that makes drawers feel like obstacles: you go for a
 * task, the drawer closes, and you have to go for it again. Here the drawer
 * closing is a side effect of the click you already meant to make.
 *
 * Anything left in the box survives being closed — the component stays mounted —
 * so a half-written thought is not the price of clicking away.
 *
 * ## Why the width is draggable and remembered
 *
 * "Pull it out over the content" is a different gesture from "open it": one is
 * for a sentence, the other is for pasting in a page of meeting notes and cutting
 * it down. The drag handle covers the whole range, the maximise button jumps
 * between the two ends for people who would rather not aim, and both the width
 * and the open state persist — a preference you have to re-express on every page
 * load is not a preference.
 *
 * The width lives in local state *during* a drag and is committed to
 * `localStorage` on release, because writing to storage on every pointermove is a
 * synchronous serialize per frame.
 *
 * ## Keyboard
 *
 * `⌘/Ctrl+K` opens the drawer and lands the caret in the box — the shortcut lives
 * here rather than in `QuickCapture` because it has to be able to open the thing
 * the textarea is inside. `Escape` closes. The drag handle is a real
 * `role="separator"` with arrow-key resizing, so the width is reachable without a
 * pointer.
 */

import * as React from 'react';
import { ChevronsLeft, ChevronsRight, PenLine, X } from 'lucide-react';

import { QuickCapture } from '@/components/resparkable/layout/quick-capture';
import { Button } from '@/components/ui/button';
import { useLocalStorage } from '@/lib/hooks/use-local-storage';
import { cn } from '@/lib/utils';

const OPEN_KEY = 'resparkable.sidekick.open.v1';
const WIDTH_KEY = 'resparkable.sidekick.width.v1';

/** Comfortable for a sentence or two; the width it opens at the first time. */
const DEFAULT_WIDTH = 384;
/** Below this the toolbar wraps and the textarea stops being usable. */
const MIN_WIDTH = 300;
/** The "pulled out" end — room for a page of pasted notes without covering everything. */
const WIDE_WIDTH = 780;
const MAX_WIDTH = 1000;
/** Arrow-key step for resizing from the keyboard. */
const KEYBOARD_STEP = 32;

function clampWidth(width: number): number {
  const ceiling =
    typeof window === 'undefined' ? MAX_WIDTH : Math.min(MAX_WIDTH, window.innerWidth - 64);
  return Math.max(MIN_WIDTH, Math.min(Math.max(ceiling, MIN_WIDTH), width));
}

export function ResparkableSidekick(): React.ReactElement {
  const [open, setOpen] = useLocalStorage<boolean>(OPEN_KEY, false);
  const [storedWidth, setStoredWidth] = useLocalStorage<number>(WIDTH_KEY, DEFAULT_WIDTH);
  /** Non-null only while a drag is in flight — see the header note on storage writes. */
  const [dragWidth, setDragWidth] = React.useState<number | null>(null);
  /** Bumped to hand focus to the textarea; the value itself carries no meaning. */
  const [focusSignal, setFocusSignal] = React.useState(0);

  const width = dragWidth ?? storedWidth;
  const panelRef = React.useRef<HTMLDivElement>(null);

  const openAndFocus = React.useCallback(() => {
    setOpen(true);
    setFocusSignal((n) => n + 1);
  }, [setOpen]);

  // ⌘K from anywhere in Resparkable. Opens first, then focuses — the effect in
  // QuickCapture runs after the panel has mounted, so the order works out even
  // when the drawer was closed.
  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openAndFocus();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openAndFocus]);

  // Escape closes — but only when the focus is inside the panel, so it cannot
  // steal the key from a dialog or a menu open on the page behind it.
  React.useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      const active = document.activeElement;
      if (active instanceof Node && panelRef.current?.contains(active)) {
        setOpen(false);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, setOpen]);

  // Clicking anywhere else closes it. The click itself is NOT swallowed — no
  // backdrop, no `preventDefault` — so the button you reached for still fires and
  // the drawer gets out of the way on the same gesture, rather than costing you a
  // dismissing click first.
  //
  // `pointerdown` rather than `click`: a drag that starts inside the panel and
  // ends outside it (releasing the resize handle past the page edge) fires a
  // `click` on the document, and closing the drawer at the end of resizing it
  // would be absurd.
  React.useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      // A node already detached by the click's own handler (a menu item that
      // unmounted its menu) is not evidence the click was outside.
      if (!target.isConnected) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, setOpen]);

  // A window that shrank below the stored width would leave the panel wider than
  // the screen with no way back short of a drag that no longer fits.
  React.useEffect(() => {
    function onResize(): void {
      setStoredWidth((current) => clampWidth(current));
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [setStoredWidth]);

  function startDrag(event: React.PointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);

    const move = (moveEvent: PointerEvent): void => {
      setDragWidth(clampWidth(window.innerWidth - moveEvent.clientX));
    };
    const finish = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      setDragWidth((final) => {
        if (final !== null) setStoredWidth(final);
        return null;
      });
    };

    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }

  // Compared against the width the button can actually reach, not the nominal
  // one. `clampWidth`'s ceiling is `innerWidth - 64`, so on a window narrower
  // than ~844px the clamped result of WIDE_WIDTH is below WIDE_WIDTH itself —
  // the panel would never register as wide, the label would stay "Widen", and
  // pressing it would re-apply the same value it already had.
  const wideTarget = clampWidth(WIDE_WIDTH);
  const isWide = width >= wideTarget - 1;

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={openAndFocus}
          // Anchored to the right edge rather than floating in a corner, because
          // it is the closed edge of the drawer — it should read as the thing
          // that slides out, not as a separate button that happens to be nearby.
          className={cn(
            'bg-background hover:bg-accent text-foreground fixed top-1/3 right-0 z-40',
            'flex items-center gap-2 rounded-l-lg border border-r-0 py-4 pr-1.5 pl-2 shadow-md',
            'focus-visible:ring-ring transition-colors focus-visible:ring-2 focus-visible:outline-none'
          )}
          aria-label="Open the capture panel (⌘K)"
          data-testid="resparkable-sidekick-handle"
        >
          <PenLine className="h-4 w-4" aria-hidden="true" />
          <span className="text-xs font-medium tracking-wide [writing-mode:vertical-rl]">
            Capture
          </span>
        </button>
      )}

      {/* Dimmed only where the panel covers the whole screen, so it reads as
          "on top of" rather than "instead of". Tapping it closes the drawer via
          the outside-pointerdown handler, like every other outside tap. */}
      {open && <div className="fixed inset-0 z-40 bg-black/40 sm:hidden" aria-hidden="true" />}

      <div
        ref={panelRef}
        role="complementary"
        aria-label="Capture"
        data-testid="resparkable-sidekick"
        // Slid off-screen rather than unmounted, and that is load-bearing: a
        // half-written thought must not be the price of clicking away. Unmounting
        // would throw away the textarea's contents, the attached file and the
        // in-flight transcript — in a product whose one unforgivable failure is
        // losing what you were trying not to lose. `inert` keeps it out of the tab
        // order and the accessibility tree while it is parked.
        inert={!open}
        aria-hidden={!open}
        className={cn(
          'bg-background fixed inset-y-0 right-0 z-50 flex border-l shadow-2xl',
          'transition-transform duration-200 ease-out motion-reduce:transition-none',
          open ? 'translate-x-0' : 'pointer-events-none translate-x-full',
          // The panel never exceeds the viewport, so a stored width from a wider
          // monitor degrades to "full screen" rather than to "off screen".
          'w-full sm:w-[min(100vw,var(--sidekick-width))]'
        )}
        style={{ ['--sidekick-width' as string]: `${width}px` }}
      >
        {/* `slider` rather than the window-splitter's `separator`: a focusable
            separator is the APG's name for this, but it is a role assistive tech
            support is thin on and lint treats as non-interactive. `slider` says
            the same thing — a value you change with the arrow keys — and both
            announce the width. */}
        <div
          role="slider"
          aria-orientation="vertical"
          aria-label="Resize the capture panel"
          aria-valuenow={width}
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={MAX_WIDTH}
          aria-valuetext={`${width} pixels wide`}
          tabIndex={0}
          onPointerDown={startDrag}
          onKeyDown={(event) => {
            const delta =
              event.key === 'ArrowLeft'
                ? KEYBOARD_STEP
                : event.key === 'ArrowRight'
                  ? -KEYBOARD_STEP
                  : 0;
            if (!delta) return;
            event.preventDefault();
            setStoredWidth((current) => clampWidth(current + delta));
          }}
          className={cn(
            'group absolute inset-y-0 left-0 hidden w-1.5 -translate-x-1/2 cursor-col-resize sm:block',
            'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none'
          )}
        >
          <div className="group-hover:bg-primary/60 group-focus-visible:bg-primary mx-auto h-full w-0.5 bg-transparent transition-colors" />
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-between gap-2 border-b px-4 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <PenLine className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden="true" />
              <h2 className="truncate text-sm font-semibold">Capture</h2>
            </div>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0"
                aria-label={isWide ? 'Narrow the capture panel' : 'Widen the capture panel'}
                onClick={() => setStoredWidth(isWide ? clampWidth(DEFAULT_WIDTH) : wideTarget)}
              >
                {isWide ? (
                  <ChevronsRight className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <ChevronsLeft className="h-4 w-4" aria-hidden="true" />
                )}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0"
                aria-label="Close the capture panel"
                onClick={() => setOpen(false)}
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </header>

          {/* `min-h-0` is what lets the textarea inside actually shrink-to-fit
              rather than overflowing the panel — a flex child's default
              `min-height: auto` would let it push past the bottom edge. */}
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <QuickCapture className="h-full" focusSignal={focusSignal} />
          </div>

          <footer className="text-muted-foreground border-t px-4 py-2 text-[11px]">
            <kbd className="bg-muted rounded px-1 py-0.5 font-mono">⌘K</kbd> from anywhere ·{' '}
            <kbd className="bg-muted rounded px-1 py-0.5 font-mono">⌘↩</kbd> to save
          </footer>
        </div>
      </div>
    </>
  );
}
