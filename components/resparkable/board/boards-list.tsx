'use client';

/**
 * BoardsList — the saved boards, and the label library.
 *
 * Labels live here rather than on a page of their own because there is nothing to say
 * about a tag beyond its name and colour, and a screen for that would be a screen
 * nobody visits. They belong next to the boards that filter and group by them.
 *
 * Each board says what it is in words — "a live query" versus "hand-picked" — because
 * that distinction decides whether dragging cards up and down means anything, and it
 * is invisible from the board itself.
 */

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LayoutGrid, Pencil, Plus, Tag as TagIcon, Trash2 } from 'lucide-react';

import { BoardForm } from '@/components/resparkable/board/board-form';
import { ArchiveControls } from '@/components/resparkable/ui/archive-controls';
import { EmptyState } from '@/components/resparkable/ui/empty-state';
import { SaveStatus, useSaveStatus } from '@/components/resparkable/ui/save-status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiClient } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';
import type { BoardWire, ProjectWire, TagWire } from '@/lib/framework/resparkable/ui/payloads';

export interface BoardsListProps {
  boards: BoardWire[];
  projects: ProjectWire[];
  tags: TagWire[];
}

export function BoardsList({ boards, projects, tags }: BoardsListProps): React.ReactElement {
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<BoardWire | null>(null);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end">
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          New board
        </Button>
      </div>

      {boards.length === 0 ? (
        <EmptyState
          icon={LayoutGrid}
          title="No boards yet"
          description="A board is a view over tasks you already have — the columns are their statuses, so dragging a card between them actually changes something. Nothing is duplicated and nothing is created."
          action={
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              Make one
            </Button>
          }
        />
      ) : (
        <ul className="space-y-2">
          {boards.map((board) => (
            <li
              key={board.id}
              className="bg-card flex flex-wrap items-center gap-2 rounded-md border p-3"
            >
              <Link
                href={RESPARKABLE_ROUTES.board(board.slug)}
                className="font-medium hover:underline"
              >
                {board.name}
              </Link>

              <Badge variant="secondary" className="text-[11px]">
                {board.membership === 'explicit' ? 'hand-picked' : 'a live query'}
              </Badge>

              {board.archivedAt !== null && (
                <Badge variant="outline" className="text-[11px]">
                  archived
                </Badge>
              )}

              <span className="ml-auto flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Edit ${board.name}`}
                  onClick={() => setEditing(board)}
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
                <ArchiveControls
                  collection={RESPARKABLE_API.BOARDS}
                  id={board.id}
                  label={board.name}
                  noun="board"
                  archived={board.archivedAt !== null}
                  compact
                />
              </span>
            </li>
          ))}
        </ul>
      )}

      <TagLibrary tags={tags} />

      <BoardForm open={createOpen} onOpenChange={setCreateOpen} projects={projects} />
      <BoardForm
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        projects={projects}
        {...(editing ? { board: editing } : {})}
      />
    </div>
  );
}

/**
 * The label library.
 *
 * Deleting a tag takes it off every task it was on — the join table cascades. The
 * copy says so, because "delete label" could plausibly mean "delete the tasks with
 * it", and that ambiguity only resolves badly.
 */
function TagLibrary({ tags }: { tags: TagWire[] }): React.ReactElement {
  const router = useRouter();
  const { state, message, run } = useSaveStatus();
  const [name, setName] = React.useState('');

  async function create(): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return;

    setName('');

    const ok = await run(() => apiClient.post(RESPARKABLE_API.TAGS, { body: { name: trimmed } }));

    if (ok) router.refresh();
    else setName(trimmed);
  }

  async function remove(tagId: string): Promise<void> {
    const ok = await run(() =>
      apiClient.delete(RESPARKABLE_API.itemPath(RESPARKABLE_API.TAGS, tagId))
    );
    if (ok) router.refresh();
  }

  return (
    <section className="bg-card space-y-3 rounded-lg border p-4">
      <div className="space-y-1">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <TagIcon className="h-4 w-4" aria-hidden="true" />
          Labels
        </h2>
        <p className="text-muted-foreground text-xs">
          Shared across every board. Renaming one updates it everywhere; deleting one takes it off
          every task that had it, without touching the tasks.
        </p>
      </div>

      {tags.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <li key={tag.id} className="flex items-center gap-1 rounded-full border px-2 py-0.5">
              <span className="text-xs">{tag.name}</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 w-5 p-0"
                aria-label={`Delete the ${tag.name} label`}
                onClick={() => void remove(tag.id)}
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="new-tag" className="text-xs">
            New label
          </Label>
          <Input
            id="new-tag"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="urgent"
            className="h-8 w-48"
          />
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={!name.trim()}>
          Add
        </Button>
        <SaveStatus state={state} message={message} />
      </form>
    </section>
  );
}
