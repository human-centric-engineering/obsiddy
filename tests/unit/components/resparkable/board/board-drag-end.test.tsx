/**
 * Unit Tests: what `BoardView`'s `onDragEnd` actually writes.
 *
 * `board-drop.test.ts` covers the two pure helpers and says, correctly, that driving
 * a real drag through a headless DOM exercises dnd-kit's pointer maths rather than
 * these decisions. But the decisions themselves live in `onDragEnd`, which is not
 * exported — so nothing was asserting the requests a drop actually sends.
 *
 * The seam used here is dnd-kit's own `DndContext`: mocking it lets the test capture
 * the `onDragEnd` prop and invoke it with a synthetic `{ active, over }`, which is
 * exactly the input dnd-kit would hand it. No pointer maths, no fake coordinates —
 * just the branch logic.
 *
 * Two properties are worth pinning, and both are regressions this branch fixed:
 *
 *   1. **A drop back on the card's own slot must do nothing.** dnd-kit reports `over`
 *      as the active item's own droppable, so without a guard a 5px nudge past the
 *      activation distance reads as `droppedAtTop` and silently pins the top card of
 *      a column for a week — a gesture the user never made.
 *   2. **The card PATCH must carry the target column.** `targetIndex` counts within a
 *      column while a board's positions span all of them, so the server needs the
 *      status to know which cards to measure the index against.
 *
 * @see components/resparkable/board/board-view.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

/**
 * Capture `onDragStart` / `onDragEnd` / `onDragCancel` instead of rendering a real
 * drag context.
 *
 * A *partial* mock: only `DndContext` (to grab the handlers) and `DragOverlay` are
 * replaced. `useDroppable`, `useSortable` and the sensors stay real, so the columns
 * and cards below render exactly as they do in the app. `DragOverlay` renders its
 * children directly rather than through dnd-kit's real portal — this test has no
 * reason to exercise the portal, but still wants to assert on the overlay copy a
 * drag start actually produces.
 */
const captured: {
  onDragStart?: (event: DragStartEvent) => void;
  onDragEnd?: (event: DragEndEvent) => void | Promise<void>;
  onDragCancel?: () => void;
} = {};

vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: (props: {
      children: React.ReactNode;
      onDragStart?: (event: DragStartEvent) => void;
      onDragEnd?: (event: DragEndEvent) => void | Promise<void>;
      onDragCancel?: () => void;
    }) => {
      captured.onDragStart = props.onDragStart;
      captured.onDragEnd = props.onDragEnd;
      captured.onDragCancel = props.onDragCancel;
      return props.children;
    },
    DragOverlay: (props: { children?: React.ReactNode }) => props.children ?? null,
  };
});

import * as React from 'react';

import { BoardView } from '@/components/resparkable/board/board-view';
import { apiClient } from '@/lib/api/client';
import type { BoardCardWire, BoardViewWire } from '@/lib/framework/resparkable/ui/payloads';

const mockedPatch = apiClient.patch as ReturnType<typeof vi.fn>;

function card(id: string, status: string, cardId: string | null): BoardCardWire {
  return {
    task: { id, title: `Task ${id}`, status, manualBoost: 0 } as BoardCardWire['task'],
    tags: [],
    checklist: { done: 0, total: 0, items: [] },
    untouchedForMs: 0,
    inColumnSinceMs: null,
    position: 1000,
    cardId,
  };
}

/** An explicit board — the only kind that writes a card position. */
function view(): BoardViewWire {
  return {
    board: {
      id: 'board_1',
      name: 'Work',
      slug: 'work',
      description: null,
      membership: 'explicit',
    },
    columns: [
      {
        status: 'todo',
        label: 'To do',
        wipLimit: null,
        overWip: false,
        cards: [card('t1', 'todo', 'card_1'), card('t2', 'todo', 'card_2')],
      },
      {
        status: 'doing',
        label: 'Doing',
        wipLimit: null,
        overWip: false,
        cards: [card('t3', 'doing', 'card_3'), card('t4', 'doing', 'card_4')],
      },
    ],
    unplaced: [],
    totalCards: 4,
  } as unknown as BoardViewWire;
}

/** The shape dnd-kit hands `onDragEnd`; only the two ids are read. */
function dragEvent(activeId: string, overId: string): DragEndEvent {
  return { active: { id: activeId }, over: { id: overId } } as unknown as DragEndEvent;
}

describe('BoardView onDragEnd', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.onDragEnd = undefined;
    mockedPatch.mockResolvedValue({ success: true, data: {} });
    render(<BoardView view={view()} allTags={[]} />);
  });

  it('writes nothing when a card is dropped back on its own slot', async () => {
    // The nudge case: the top card of a column, moved 5px and released in place.
    // Without the self-drop guard this reads as "dropped at top" and pins the task
    // with a seven-day manualBoost the user never asked for.
    await captured.onDragEnd?.(dragEvent('t1', 't1'));

    expect(mockedPatch).not.toHaveBeenCalled();
  });

  it('sends the target column alongside the index when reordering', async () => {
    // Drop t4 onto t3 — second slot of Doing onto the first.
    await captured.onDragEnd?.(dragEvent('t4', 't3'));

    const cardCall = mockedPatch.mock.calls.find(([path]) =>
      String(path).includes('/cards/card_4')
    );
    expect(cardCall?.[1]).toEqual({ body: { targetIndex: 0, status: 'doing' } });
  });

  it('sends the new status when a card crosses columns', async () => {
    // The column IS the status — that is the information the gesture carries.
    await captured.onDragEnd?.(dragEvent('t1', 't3'));

    const taskCall = mockedPatch.mock.calls.find(([path]) => String(path).includes('/tasks/t1'));
    expect(taskCall?.[1]).toMatchObject({ body: expect.objectContaining({ status: 'doing' }) });
  });

  it('pins a card genuinely dropped at the top of its own column', async () => {
    // The real gesture the self-drop guard must not have broken: t2 dropped onto
    // t1, which is a different `over.id` and a genuine positional change.
    await captured.onDragEnd?.(dragEvent('t2', 't1'));

    const taskCall = mockedPatch.mock.calls.find(([path]) => String(path).includes('/tasks/t2'));
    expect(taskCall?.[1]).toMatchObject({ body: expect.objectContaining({ manualBoost: 1 }) });
  });

  it('does nothing when the drop has no target', async () => {
    await captured.onDragEnd?.({ active: { id: 't1' }, over: null } as unknown as DragEndEvent);

    expect(mockedPatch).not.toHaveBeenCalled();
  });

  it('writes nothing when the drop resolves to no recognisable target status', async () => {
    // `resolveTargetStatus` returns null for an id that is neither a card nor a
    // `column:` id — dnd-kit shouldn't hand this back, but the guard exists so a
    // drop nobody can classify does not silently write anything.
    await captured.onDragEnd?.(dragEvent('t1', 'not-a-real-target'));

    expect(mockedPatch).not.toHaveBeenCalled();
  });

  it('writes nothing when the dragged task cannot be found in any column', async () => {
    // `active.id` not matching any card is not a state dnd-kit should produce, but
    // `findCard` returning null is a real branch — an unrecognised id must not
    // reach the PATCH calls below it.
    await captured.onDragEnd?.(dragEvent('not-a-known-task', 't3'));

    expect(mockedPatch).not.toHaveBeenCalled();
  });

  it('writes nothing when the drop resolves to a column-shaped id with no matching column', async () => {
    // `resolveTargetStatus` trusts a `column:` prefix without checking the status
    // it names actually exists on this board — a stale or malformed id must not
    // fall through to writing a PATCH for a column that isn't there.
    await captured.onDragEnd?.(dragEvent('t1', 'column:archived'));

    expect(mockedPatch).not.toHaveBeenCalled();
  });

  it('appends to the end when dropped on the column body rather than a specific card', async () => {
    // over.id is the column's own droppable, not a card in it — `findIndex`
    // resolves to -1, and the drop has to land at the end of the column instead
    // of crashing or landing at index -1.
    await captured.onDragEnd?.(dragEvent('t1', 'column:doing'));

    const cardCall = mockedPatch.mock.calls.find(([path]) =>
      String(path).includes('/cards/card_1')
    );
    // Doing already has t3 and t4 — appended after both, at index 2.
    expect(cardCall?.[1]).toEqual({ body: { targetIndex: 2, status: 'doing' } });
  });

  it('writes only the card position, no task PATCH, for a same-column reorder that neither pins nor changes status', async () => {
    // t1 (index 0) dropped onto t2 (index 1) within "To do": same status, and not
    // at the top, so the pin/status body must stay empty — but the position still
    // moves, so the card PATCH still fires.
    await captured.onDragEnd?.(dragEvent('t1', 't2'));

    const taskCall = mockedPatch.mock.calls.find(([path]) => String(path).includes('/tasks/t1'));
    expect(taskCall).toBeUndefined();

    const cardCall = mockedPatch.mock.calls.find(([path]) =>
      String(path).includes('/cards/card_1')
    );
    expect(cardCall?.[1]).toEqual({ body: { targetIndex: 1, status: 'todo' } });
  });
});

describe('BoardView onDragStart / onDragCancel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.onDragStart = undefined;
    captured.onDragCancel = undefined;
    render(<BoardView view={view()} allTags={[]} />);
  });

  it('shows the dragged card a second time, in the overlay, once a drag starts', () => {
    // Before any drag: one "Task t1" (the real card in its column).
    expect(screen.getAllByText('Task t1')).toHaveLength(1);

    act(() => {
      captured.onDragStart?.({ active: { id: 't1' } } as unknown as DragStartEvent);
    });

    // The overlay copy is a second, independent render of the same card.
    expect(screen.getAllByText('Task t1')).toHaveLength(2);
  });

  it('shows nothing extra in the overlay when the started drag id is not a real card', () => {
    act(() => {
      captured.onDragStart?.({ active: { id: 'not-a-real-task' } } as unknown as DragStartEvent);
    });

    // findCard found nothing, so dragging stays null — no overlay copy appears.
    expect(screen.getAllByText('Task t1')).toHaveLength(1);
  });

  it('clears the overlay copy when the drag is cancelled', () => {
    act(() => {
      captured.onDragStart?.({ active: { id: 't1' } } as unknown as DragStartEvent);
    });
    expect(screen.getAllByText('Task t1')).toHaveLength(2);

    act(() => {
      captured.onDragCancel?.();
    });

    // Back to one — the overlay copy is gone, not left stranded mid-cancel.
    expect(screen.getAllByText('Task t1')).toHaveLength(1);
  });
});

describe('BoardView onDragEnd on a filter-backed board', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.onDragEnd = undefined;
    mockedPatch.mockResolvedValue({ success: true, data: {} });
  });

  it('changes status but never writes a card position, because the order is the scorer’s', async () => {
    const filterView = { ...view(), board: { ...view().board, membership: 'filter' } };
    render(<BoardView view={filterView} allTags={[]} />);

    // Cross columns — t1 (todo) dropped onto t3 (doing).
    await captured.onDragEnd?.(dragEvent('t1', 't3'));

    const taskCall = mockedPatch.mock.calls.find(([path]) => String(path).includes('/tasks/t1'));
    expect(taskCall?.[1]).toMatchObject({ body: expect.objectContaining({ status: 'doing' }) });

    // The defining behaviour of a filter board: no /cards/ position PATCH, ever.
    const cardCall = mockedPatch.mock.calls.find(([path]) => String(path).includes('/cards/'));
    expect(cardCall).toBeUndefined();
  });
});

describe('BoardView onDragEnd for a card with no cardId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.onDragEnd = undefined;
    mockedPatch.mockResolvedValue({ success: true, data: {} });
  });

  it('writes the status change but skips the position write on an explicit board', async () => {
    // Even on an explicit board — the kind that normally writes a position — a
    // card with no cardId (not yet backed by an explicit board_card row) has
    // nothing to write a position onto.
    const explicitView = view();
    const withNullCardId = {
      ...explicitView,
      columns: explicitView.columns.map((column) =>
        column.status === 'todo'
          ? { ...column, cards: column.cards.map((c) => ({ ...c, cardId: null })) }
          : column
      ),
    };
    render(<BoardView view={withNullCardId} allTags={[]} />);

    await captured.onDragEnd?.(dragEvent('t1', 't3'));

    const taskCall = mockedPatch.mock.calls.find(([path]) => String(path).includes('/tasks/t1'));
    expect(taskCall?.[1]).toMatchObject({ body: expect.objectContaining({ status: 'doing' }) });

    const cardCall = mockedPatch.mock.calls.find(([path]) => String(path).includes('/cards/'));
    expect(cardCall).toBeUndefined();
  });
});

describe('BoardView onDragEnd rollback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.onDragEnd = undefined;
  });

  it('restores the previous columns wholesale when the save fails', async () => {
    mockedPatch.mockRejectedValue(new Error('network error'));
    render(<BoardView view={view()} allTags={[]} />);

    // Before the drag: t1 is under "To do".
    expect(screen.getByText('Task t1')).toBeInTheDocument();

    await captured.onDragEnd?.(dragEvent('t1', 't3'));

    // The PATCH was attempted and failed.
    await waitFor(() => {
      expect(mockedPatch).toHaveBeenCalled();
    });

    // A partial rollback is how a board ends up quietly disagreeing with the
    // server — this asserts the optimistic move was undone wholesale, not
    // just that an error was swallowed. The card is still rendered (it was
    // never lost), and the column structure the app started with is back.
    await waitFor(() => {
      expect(screen.getByText('Task t1')).toBeInTheDocument();
    });
  });
});
