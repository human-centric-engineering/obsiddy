'use client';

/**
 * SaveStatus — the inline replacement for a toast library.
 *
 * Sunrise ships no toast primitive and Obsiddy deliberately does not add one
 * (`plan.md` §9: missing primitives get built fork-owned, not installed). A
 * dependency for "tell the user the thing saved" is not worth the bundle, and a
 * toast is the wrong shape for this UI anyway: Obsiddy's writes are small,
 * frequent and attached to a specific control — a pin, a snooze, a card drag —
 * so the confirmation belongs *next to that control*, not floating in a corner
 * where it covers the next thing you were about to click.
 *
 * The accessibility rule is the whole reason this is a component rather than a
 * `<span>` written out at each call site: an optimistic UI changes the screen
 * without the user having asked for a navigation, so a screen-reader user gets
 * no announcement unless something is in a live region. `aria-live="polite"`
 * queues the message behind whatever is being read rather than interrupting it —
 * correct for "saved", and correct for "couldn't save" too, because the failure
 * is already visible in the rolled-back UI.
 *
 * The region is rendered **even when idle**. A live region only announces
 * changes to text inside an element the screen reader is already watching, so
 * mounting it at the moment of the message is the classic mistake that makes it
 * silent.
 */

import * as React from 'react';
import { AlertCircle, Check, Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export interface SaveStatusProps {
  state: SaveState;
  /** Shown for `error`, and overrides the default text for the other states. */
  message?: string | null;
  className?: string;
}

const DEFAULT_TEXT: Record<Exclude<SaveState, 'idle'>, string> = {
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Couldn’t save',
};

export function SaveStatus({ state, message, className }: SaveStatusProps): React.ReactElement {
  const text = state === 'idle' ? '' : (message ?? DEFAULT_TEXT[state]);

  return (
    <p
      // Always mounted — see the header note.
      aria-live="polite"
      aria-atomic="true"
      className={cn(
        'flex items-center gap-1.5 text-xs',
        state === 'error' ? 'text-destructive' : 'text-muted-foreground',
        className
      )}
    >
      {state === 'saving' && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
      {state === 'saved' && <Check className="h-3 w-3" aria-hidden="true" />}
      {state === 'error' && <AlertCircle className="h-3 w-3" aria-hidden="true" />}
      {text}
    </p>
  );
}

/**
 * The state machine every Obsiddy mutation uses, so the pattern is written once.
 *
 * `run` reports `saving`, then `saved` or `error`, and **returns whether the
 * call succeeded** so the caller can roll back an optimistic update. It does not
 * roll back for you: only the caller knows what it changed.
 *
 * The `saved` state clears itself after a moment. The `error` state does not —
 * a failure that disappears on its own is a failure the user never read.
 */
export function useSaveStatus(): {
  state: SaveState;
  message: string | null;
  run: (
    action: () => Promise<unknown>,
    errorMessage?: (error: unknown) => string
  ) => Promise<boolean>;
  reset: () => void;
} {
  const [state, setState] = React.useState<SaveState>('idle');
  const [message, setMessage] = React.useState<string | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const reset = React.useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setState('idle');
    setMessage(null);
  }, []);

  const run = React.useCallback(
    async (
      action: () => Promise<unknown>,
      errorMessage?: (error: unknown) => string
    ): Promise<boolean> => {
      if (timer.current) clearTimeout(timer.current);
      setState('saving');
      setMessage(null);

      try {
        await action();
        setState('saved');
        timer.current = setTimeout(() => setState('idle'), 2000);
        return true;
      } catch (error) {
        setState('error');
        setMessage(
          errorMessage?.(error) ?? (error instanceof Error ? error.message : 'Something went wrong')
        );
        return false;
      }
    },
    []
  );

  return { state, message, run, reset };
}
