'use client';

/**
 * AutoGrowTextarea — a textarea that is as tall as what you have typed.
 *
 * A fixed two-row box is wrong at both ends of the range it has to cover. Empty,
 * it is a large grey slab implying you owe it a paragraph. Six lines in, it is a
 * two-line porthole you scroll a thought through, and you cannot see the start of
 * your own sentence while writing the end of it. This starts small and grows to a
 * cap.
 *
 * ## Why the height is measured rather than counted
 *
 * The obvious implementation counts `\n` and multiplies by a line height. It is
 * wrong the moment a line soft-wraps, which on a narrow composer is most lines,
 * and wrong again for any font the browser substitutes. So instead: collapse the
 * element to `auto`, read the `scrollHeight` the browser computes for the real
 * content at the real width, and set that.
 *
 * The collapse is not optional. Without it `scrollHeight` can never report less
 * than the current height, so the box grows and never shrinks — delete a
 * paragraph and you are left with the hole it used to occupy.
 *
 * ## The cap, and why overflow flips with it
 *
 * `maxRows` exists because "grows with the text" without a ceiling means a long
 * paste eats the transcript above it, which is the thing you were writing *about*.
 * At the cap the element becomes a scroller, so `overflow-y` has to flip from
 * `hidden` to `auto` at exactly the same point — leave it on `auto` throughout
 * and a scrollbar flickers in and out on every keystroke near a line boundary.
 *
 * ## Layout effect, not effect
 *
 * `useLayoutEffect` runs before paint. With a plain `useEffect` the browser
 * paints one frame at the old height, and continuous typing turns that into a
 * visible shimmer at every line break.
 */

import * as React from 'react';

import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

export interface AutoGrowTextareaProps extends Omit<
  React.ComponentPropsWithoutRef<typeof Textarea>,
  'rows' | 'value'
> {
  value: string;
  /** Height floor, in lines. Default 1 — the box starts as a single line. */
  minRows?: number;
  /** Height ceiling, in lines. Past this it scrolls. Default 10. */
  maxRows?: number;
}

/**
 * Line height in pixels, read from the element's own computed style rather than
 * assumed, because this composer is monospaced (`.terminal-surface` sets a
 * different family and leading from the rest of the app) and a hardcoded 20px
 * would cap it at the wrong number of lines.
 *
 * `normal` is the one computed value that isn't a length — browsers report it
 * when no line-height is set. 1.4× the font size is the usual interpretation.
 */
function lineHeightOf(element: HTMLTextAreaElement): number {
  const style = window.getComputedStyle(element);
  const parsed = Number.parseFloat(style.lineHeight);
  if (Number.isFinite(parsed)) return parsed;
  const fontSize = Number.parseFloat(style.fontSize);
  return Number.isFinite(fontSize) ? fontSize * 1.4 : 20;
}

export const AutoGrowTextarea = React.forwardRef<HTMLTextAreaElement, AutoGrowTextareaProps>(
  ({ value, minRows = 1, maxRows = 10, className, ...props }, forwardedRef) => {
    const innerRef = React.useRef<HTMLTextAreaElement | null>(null);

    // Merge the forwarded ref with the local one: callers need the node to focus
    // it after sending, and this component needs it to measure.
    const setRefs = React.useCallback(
      (node: HTMLTextAreaElement | null) => {
        innerRef.current = node;
        if (typeof forwardedRef === 'function') forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      },
      [forwardedRef]
    );

    React.useLayoutEffect(() => {
      const element = innerRef.current;
      if (!element) return;

      const style = window.getComputedStyle(element);
      const lineHeight = lineHeightOf(element);
      // Padding and borders are outside `scrollHeight`'s content box in
      // `box-sizing: border-box`, but the row maths is in text lines — so the
      // chrome has to be added to both bounds or the cap lands a line early.
      const chrome =
        Number.parseFloat(style.paddingTop) +
        Number.parseFloat(style.paddingBottom) +
        Number.parseFloat(style.borderTopWidth) +
        Number.parseFloat(style.borderBottomWidth);

      // Collapse first — `scrollHeight` never reports less than the current
      // height, so without this the box can only ever grow.
      element.style.height = 'auto';

      const min = lineHeight * minRows + chrome;
      const max = lineHeight * maxRows + chrome;
      const next = Math.min(Math.max(element.scrollHeight, min), max);

      element.style.height = `${next}px`;
      // Flip with the cap, not before it: `auto` throughout makes a scrollbar
      // flicker on every keystroke near a line boundary.
      element.style.overflowY = element.scrollHeight > max ? 'auto' : 'hidden';
    }, [value, minRows, maxRows]);

    return (
      <Textarea
        {...props}
        ref={setRefs}
        value={value}
        rows={minRows}
        // `resize-none`: the drag handle fights a box that sets its own height,
        // and a user-dragged height is overwritten on the next keystroke.
        //
        // `min-h-0` is load-bearing. The base `<Textarea>` ships `min-h-[60px]`,
        // and `min-height` constrains `height` rather than being overridden by
        // it — so the inline height computed above would silently floor at 60px
        // and `minRows={1}` would render as three. The bounds are this
        // component's job; the primitive's floor has to get out of the way.
        className={cn('min-h-0 resize-none', className)}
      />
    );
  }
);
AutoGrowTextarea.displayName = 'AutoGrowTextarea';
