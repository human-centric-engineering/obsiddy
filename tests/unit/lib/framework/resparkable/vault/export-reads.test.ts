/**
 * Unit Tests: the half of vault export that talks to the database.
 *
 * `round-trip.test.ts` covers `assembleVaultFiles`, which is pure and is where
 * the interesting encoding lives. This file covers `collectVaultNotes` and its
 * two callers — the part that decides *what gets read*, which is exactly the
 * part a pure test cannot see:
 *
 *   1. **The per-type cap throws; it never truncates.** Half an export looks
 *      identical to a brain half that size, and it is the half somebody would
 *      later restore from. `PAGE` deliberately reads `MAX + 1` so overflow is
 *      detectable at all — a test that only checked `take` would miss the point.
 *   2. **`includeArchived` reaches every list except links**, because
 *      `ResparkableLink` has no archive state and passing the flag would be an
 *      option the repo silently ignores.
 *   3. **Only accepted links are exported.** A proposed link is a suggestion the
 *      user has not agreed to; writing it into a note body would launder a guess
 *      into a fact that then round-trips back in as one.
 *   4. **Every read is owner-scoped.** There is no `userId` in `export.ts` and no
 *      Prisma import, so this holds by construction — asserted anyway, because
 *      "structurally impossible" stops being true the first time somebody adds a
 *      convenience read.
 *
 * @see lib/framework/resparkable/vault/export.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/framework/resparkable/repo/areas', () => ({ listAreas: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/checklist', () => ({ listChecklistForTasks: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/documents', () => ({ listDocuments: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/entities', () => ({ listEntities: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/goals', () => ({ listGoals: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/links', () => ({ listLinks: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/projects', () => ({ listProjects: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/reviews', () => ({ listReviews: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/tags', () => ({ listTagsForTasks: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/tasks', () => ({ listTasks: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/thoughts', () => ({ listThoughts: vi.fn() }));

import { listAreas } from '@/lib/framework/resparkable/repo/areas';
import { listChecklistForTasks } from '@/lib/framework/resparkable/repo/checklist';
import { listDocuments } from '@/lib/framework/resparkable/repo/documents';
import { listEntities } from '@/lib/framework/resparkable/repo/entities';
import { listGoals } from '@/lib/framework/resparkable/repo/goals';
import { listLinks } from '@/lib/framework/resparkable/repo/links';
import type { OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { listProjects } from '@/lib/framework/resparkable/repo/projects';
import { listReviews } from '@/lib/framework/resparkable/repo/reviews';
import { listTagsForTasks } from '@/lib/framework/resparkable/repo/tags';
import { listTasks } from '@/lib/framework/resparkable/repo/tasks';
import { listThoughts } from '@/lib/framework/resparkable/repo/thoughts';
import {
  buildVaultArchive,
  buildVaultExport,
  collectVaultNotes,
  VAULT_EXPORT_MAX_PER_TYPE,
  VaultExportError,
} from '@/lib/framework/resparkable/vault/export';
import { VAULT_MANIFEST_PATH, type VaultNoteType } from '@/lib/framework/resparkable/vault/layout';

const SCOPE = { userId: 'user_a' } as unknown as OwnerScope;

/** Every list the collector calls, so "scoped" is asserted across all of them. */
const ALL_LISTS = [
  listAreas,
  listGoals,
  listProjects,
  listTasks,
  listThoughts,
  listEntities,
  listReviews,
  listDocuments,
  listLinks,
];

beforeEach(() => {
  vi.clearAllMocks();
  for (const list of ALL_LISTS) vi.mocked(list).mockResolvedValue([] as never);
  vi.mocked(listTagsForTasks).mockResolvedValue([] as never);
  vi.mocked(listChecklistForTasks).mockResolvedValue([] as never);
});

describe('collectVaultNotes — the per-type cap', () => {
  it('reads one row past the cap, so overflow is detectable at all', async () => {
    await collectVaultNotes(SCOPE);

    // If `take` were exactly the cap, a brain of precisely MAX rows would be
    // indistinguishable from one of MAX + 4,000 and would export silently.
    expect(listAreas).toHaveBeenCalledWith(
      SCOPE,
      expect.objectContaining({ take: VAULT_EXPORT_MAX_PER_TYPE + 1 })
    );
  });

  it('throws rather than truncating when a type is over the cap', async () => {
    vi.mocked(listTasks).mockResolvedValue(
      Array.from({ length: VAULT_EXPORT_MAX_PER_TYPE + 1 }, (_, i) => ({
        id: `task_${i}`,
        title: 'x',
      })) as never
    );

    await expect(collectVaultNotes(SCOPE)).rejects.toBeInstanceOf(VaultExportError);
    await expect(collectVaultNotes(SCOPE)).rejects.toMatchObject({ reason: 'too-many-records' });
  });

  it('names the type that overflowed, so the message is actionable', async () => {
    vi.mocked(listThoughts).mockResolvedValue(
      Array.from({ length: VAULT_EXPORT_MAX_PER_TYPE + 1 }, (_, i) => ({
        id: `thought_${i}`,
        content: 'x',
      })) as never
    );

    await expect(collectVaultNotes(SCOPE)).rejects.toThrow(/thought/);
  });

  it('accepts a brain sitting exactly on the cap', async () => {
    vi.mocked(listAreas).mockResolvedValue(
      Array.from({ length: VAULT_EXPORT_MAX_PER_TYPE }, (_, i) => ({
        id: `area_${i}`,
        name: `Area ${i}`,
      })) as never
    );

    // The boundary is "more than", not "at least".
    await expect(collectVaultNotes(SCOPE)).resolves.toHaveLength(VAULT_EXPORT_MAX_PER_TYPE);
  });
});

describe('collectVaultNotes — what gets read', () => {
  it('scopes every read to the caller', async () => {
    await collectVaultNotes(SCOPE);

    // The scope is always the first argument, whatever else a given list takes.
    for (const list of ALL_LISTS) {
      expect(vi.mocked(list)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(list).mock.calls[0]?.[0]).toBe(SCOPE);
    }
    expect(vi.mocked(listTagsForTasks).mock.calls[0]?.[0]).toBe(SCOPE);
    expect(vi.mocked(listChecklistForTasks).mock.calls[0]?.[0]).toBe(SCOPE);
  });

  it('leaves archived rows out by default', async () => {
    await collectVaultNotes(SCOPE);

    expect(listAreas).toHaveBeenCalledWith(
      SCOPE,
      expect.objectContaining({ includeArchived: false })
    );
    expect(vi.mocked(listTasks).mock.calls[0]?.[2]).toMatchObject({ includeArchived: false });
  });

  it('passes includeArchived through when asked', async () => {
    await collectVaultNotes(SCOPE, { includeArchived: true });

    expect(listAreas).toHaveBeenCalledWith(
      SCOPE,
      expect.objectContaining({ includeArchived: true })
    );
    expect(vi.mocked(listReviews).mock.calls[0]?.[2]).toMatchObject({ includeArchived: true });
  });

  it('does not pass includeArchived to links, which have no archive state', async () => {
    await collectVaultNotes(SCOPE, { includeArchived: true });

    const linkOptions = vi.mocked(listLinks).mock.calls[0]?.[2] as Record<string, unknown>;
    expect(linkOptions).not.toHaveProperty('includeArchived');
  });

  it('exports accepted links only', async () => {
    await collectVaultNotes(SCOPE);

    // A proposed link is a suggestion the user has not agreed to. Writing it
    // into a note body would turn a guess into a fact on the next import.
    expect(vi.mocked(listLinks).mock.calls[0]?.[1]).toMatchObject({ status: 'accepted' });
  });

  it('reads tags and checklist items in one batch keyed on the task ids it found', async () => {
    vi.mocked(listTasks).mockResolvedValue([
      { id: 'task_1', title: 'One' },
      { id: 'task_2', title: 'Two' },
    ] as never);

    await collectVaultNotes(SCOPE);

    // One call each, not one per task.
    expect(listTagsForTasks).toHaveBeenCalledTimes(1);
    expect(listChecklistForTasks).toHaveBeenCalledTimes(1);
    expect(listTagsForTasks).toHaveBeenCalledWith(SCOPE, ['task_1', 'task_2']);
    expect(listChecklistForTasks).toHaveBeenCalledWith(SCOPE, ['task_1', 'task_2']);
  });
});

describe('buildVaultExport', () => {
  it('produces a working starter vault from an empty brain', async () => {
    const result = await buildVaultExport(SCOPE, { now: new Date('2026-08-06T09:00:00Z') });

    // The whole "no second generator to rot" claim: an empty export is still a
    // vault somebody can open.
    expect(result.files['README.md']).toBeTruthy();
    expect(result.files['.obsidian/app.json']).toBeTruthy();
    expect(result.files[VAULT_MANIFEST_PATH]).toBeTruthy();
    expect(Object.values(result.counts).every((count) => count === 0)).toBe(true);
  });

  it('records whether archived rows were included in the manifest', async () => {
    const result = await buildVaultExport(SCOPE, {
      includeArchived: true,
      now: new Date('2026-08-06T09:00:00Z'),
    });

    expect(result.includesArchived).toBe(true);
    const manifest = JSON.parse(result.files[VAULT_MANIFEST_PATH]) as Record<string, unknown>;
    expect(manifest.includesArchived).toBe(true);
    expect(manifest.generator).toBe('resparkable');
  });
});

describe('buildVaultArchive', () => {
  it('names the file from the generation date, not from anything user-supplied', async () => {
    const archive = await buildVaultArchive(SCOPE, { now: new Date('2026-08-06T09:00:00Z') });

    // The route interpolates this straight into a Content-Disposition header.
    expect(archive.fileName).toBe('resparkable-vault-2026-08-06.zip');
    expect(archive.fileName).not.toMatch(/["\r\n]/);
  });

  it('returns real zip bytes and the per-type counts alongside them', async () => {
    const archive = await buildVaultArchive(SCOPE, { now: new Date('2026-08-06T09:00:00Z') });

    expect(archive.bytes.byteLength).toBeGreaterThan(0);
    // Local file header magic — proves this is an archive, not a JSON fallback.
    expect(Array.from(archive.bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(archive.counts).toMatchObject({ area: 0, task: 0 });
  });

  it('propagates the cap error rather than shipping a partial archive', async () => {
    vi.mocked(listProjects).mockResolvedValue(
      Array.from({ length: VAULT_EXPORT_MAX_PER_TYPE + 1 }, (_, i) => ({
        id: `project_${i}`,
        name: 'x',
      })) as never
    );

    await expect(buildVaultArchive(SCOPE)).rejects.toBeInstanceOf(VaultExportError);
  });
});

// ─── Added: the cross-referencing collectVaultNotes does before encoding ─────
//
// Every test above keeps every list empty (or, for the tag/checklist batching
// test, populated with bare `{id, title}` tasks). That is correct for what
// those tests check, but it means the index-building in the middle of
// `collectVaultNotes` — areaNameById, projectNameById, goalTitleById,
// tagsByTask, checklistByTask, tasksByProject, and the two-directional
// `titleByRef`/`linksByRef` a link is resolved through — has never run over
// anything with a second row to cross-reference. `round-trip.test.ts` covers
// the same territory but starts from hand-encoded `CollectedNote[]`, which
// skips this exact wiring; this is the one place that wiring is exercised
// against raw repo rows.
describe('collectVaultNotes — cross-references resolved from raw rows', () => {
  const AREA = {
    id: 'area_1',
    name: 'The business',
    slug: 'the-business',
    description: null,
    targetWeeklyMinutes: null,
  };
  const GOAL = {
    id: 'goal_1',
    title: 'Ship it',
    slug: 'ship-it',
    horizon: 'quarter',
    status: 'active',
    targetDate: null,
    description: null,
    areaId: 'area_1',
    parentGoalId: null,
  };
  // A child goal, so `goalTitleById.get(goal.parentGoalId)` resolves through a
  // real second row rather than always taking the `parentGoalId` falsy branch.
  const GOAL_CHILD = {
    id: 'goal_2',
    title: 'Beta first',
    slug: 'beta-first',
    horizon: 'month',
    status: 'active',
    targetDate: null,
    description: null,
    areaId: null,
    parentGoalId: 'goal_1',
  };
  const PROJECT = {
    id: 'project_1',
    name: 'Website rebuild',
    slug: 'website-rebuild',
    status: 'active',
    description: null,
    areaId: 'area_1',
  };
  // A second project purely to be the other end of `LINK` — `encodeProject`
  // is the only encoder that renders a `## Links` block at all (see
  // `notes.ts`: `links` is not a parameter of `encodeTask` or any of the
  // others), so exercising both the forward and backward halves of
  // `linksByRef` with an assertion that can actually see the result means
  // linking two projects rather than a project and a task.
  const PROJECT_2 = {
    id: 'project_2',
    name: 'Marketing site',
    slug: 'marketing-site',
    status: 'active',
    description: null,
    areaId: null,
  };
  // Linked to nothing, so `linksByRef.get('project:project_3')` misses and the
  // `?? []` fallback in the project's `links:` line actually runs.
  const PROJECT_3 = {
    id: 'project_3',
    name: 'Internal tools',
    slug: 'internal-tools',
    status: 'active',
    description: null,
    areaId: null,
  };
  const TASK = {
    id: 'task_1',
    title: 'Ship the beta',
    status: 'todo',
    notes: null,
    dueAt: null,
    deferUntil: null,
    estimateMinutes: null,
    energy: null,
    contextTag: null,
    projectId: 'project_1',
  };
  const THOUGHT = {
    id: 'thought_1',
    content: 'What if capture worked from the lock screen',
    status: 'inbox',
    createdAt: new Date('2026-07-01T08:00:00.000Z'),
  };
  const ENTITY = {
    id: 'entity_1',
    name: 'Dana',
    slug: 'dana',
    kind: 'person',
    status: 'active',
    website: null,
    description: null,
  };
  const REVIEW = {
    id: 'review_1',
    title: 'Week 31',
    horizon: 'weekly',
    body: 'A generated weekly review.',
    generatedAt: new Date('2026-08-03T06:00:00.000Z'),
  };
  const DOCUMENT = {
    id: 'document_1',
    title: 'Contract',
    fileName: 'contract.pdf',
    mimeType: 'application/pdf',
    byteSize: 240_000,
    extractedText: 'The parties agree…',
  };
  // project_1 → project_2, so both the forward and backward halves of the
  // bidirectional link index get exercised, each landing on a note type that
  // actually renders a Links block.
  const LINK = {
    sourceType: 'project',
    sourceId: 'project_1',
    targetType: 'project',
    targetId: 'project_2',
    kind: 'supports',
    strength: 0.71,
    rationale: 'Same push',
  };
  // Neither end names anything this export collected — a link into a section
  // that never travelled, or a stale row a later edit removed. Both
  // `if (forward)` and `if (backward)` must independently take their false
  // branch, and not throw doing it.
  const LINK_ORPHAN = {
    sourceType: 'task',
    sourceId: 'task_missing',
    targetType: 'project',
    targetId: 'project_missing',
    kind: 'relates-to',
    strength: null,
    rationale: null,
  };

  beforeEach(() => {
    vi.mocked(listAreas).mockResolvedValue([AREA] as never);
    vi.mocked(listGoals).mockResolvedValue([GOAL, GOAL_CHILD] as never);
    vi.mocked(listProjects).mockResolvedValue([PROJECT, PROJECT_2, PROJECT_3] as never);
    vi.mocked(listTasks).mockResolvedValue([TASK] as never);
    vi.mocked(listThoughts).mockResolvedValue([THOUGHT] as never);
    vi.mocked(listEntities).mockResolvedValue([ENTITY] as never);
    vi.mocked(listReviews).mockResolvedValue([REVIEW] as never);
    vi.mocked(listDocuments).mockResolvedValue([DOCUMENT] as never);
    vi.mocked(listLinks).mockResolvedValue([LINK, LINK_ORPHAN] as never);
    vi.mocked(listTagsForTasks).mockResolvedValue([
      { taskId: 'task_1', tag: { name: 'deep-work' } },
    ] as never);
    // Deliberately out of position order — the collector sorts by `position`,
    // and rows arriving pre-sorted from the repo would leave that comparator
    // never actually invoked.
    vi.mocked(listChecklistForTasks).mockResolvedValue([
      { taskId: 'task_1', text: 'Tag the release', isDone: false, position: 1 },
      { taskId: 'task_1', text: 'Write the changelog', isDone: true, position: 0 },
    ] as never);
  });

  function collectedFor(items: Awaited<ReturnType<typeof collectVaultNotes>>, type: VaultNoteType) {
    const found = items.find((item) => item.type === type);
    if (!found) throw new Error(`No collected note of type ${type}`);
    return found;
  }

  function collectedById(items: Awaited<ReturnType<typeof collectVaultNotes>>, id: string) {
    const found = items.find((item) => item.id === id);
    if (!found) throw new Error(`No collected note with id ${id}`);
    return found;
  }

  it('produces one collected note per row for every type, not just the ones already tested', async () => {
    const collected = await collectVaultNotes(SCOPE);

    expect(new Set(collected.map((item) => item.type))).toEqual(
      new Set(['area', 'document', 'entity', 'goal', 'project', 'review', 'task', 'thought'])
    );
    // Multiple rows of the same type — proves this counts rows, not just types seen.
    expect(collected.filter((item) => item.type === 'project')).toHaveLength(3);
    expect(collected.filter((item) => item.type === 'goal')).toHaveLength(2);
    expect(collected).toHaveLength(11);
  });

  it("resolves a goal's area id to the area's name", async () => {
    const collected = await collectVaultNotes(SCOPE);

    expect(collectedById(collected, 'goal_1').note.frontmatter.area).toBe('[[The business]]');
  });

  it("resolves a child goal's parentGoalId to the parent's title", async () => {
    const collected = await collectVaultNotes(SCOPE);

    expect(collectedById(collected, 'goal_2').note.frontmatter.parent).toBe('[[Ship it]]');
  });

  it("resolves a project's area and embeds its tasks as a generated checkbox block", async () => {
    const collected = await collectVaultNotes(SCOPE);

    const project = collectedFor(collected, 'project');
    expect(project.note.frontmatter.area).toBe('[[The business]]');
    expect(project.note.body).toContain('- [ ] Ship the beta ^bt-task_1');
  });

  it("resolves a task's project, tags and checklist, keyed off its own id", async () => {
    const collected = await collectVaultNotes(SCOPE);

    const task = collectedFor(collected, 'task');
    expect(task.note.frontmatter.project).toBe('[[Website rebuild]]');
    expect(task.note.frontmatter.tags).toEqual(['deep-work']);
    expect(task.note.body).toContain('- [ ] Tag the release');
  });

  it('orders a task’s checklist by position, not by the order the repo returned it in', async () => {
    const collected = await collectVaultNotes(SCOPE);

    const task = collectedFor(collected, 'task');
    const changelogLine = task.note.body.indexOf('Write the changelog');
    const tagReleaseLine = task.note.body.indexOf('Tag the release');

    expect(changelogLine).toBeGreaterThan(-1);
    expect(changelogLine).toBeLessThan(tagReleaseLine);
    // position 0 is done; position 1 is not.
    expect(task.note.body).toContain('- [x] Write the changelog');
    expect(task.note.body).toContain('- [ ] Tag the release');
  });

  it('resolves an accepted link on both the source and the target note', async () => {
    // The header comment on `linksByRef` says a link is symmetric to a reader —
    // asserted here on both ends, not just the one a single-direction test
    // would happen to check.
    const collected = await collectVaultNotes(SCOPE);

    const source = collectedById(collected, 'project_1');
    const target = collectedById(collected, 'project_2');

    // Forward: the source names the target it supports.
    expect(source.note.body).toContain('- supports: [[Marketing site]] (0.71) — Same push');
    // Backward: the target is shown as supported by the source.
    expect(target.note.body).toContain('- supports: [[Website rebuild]] (0.71) — Same push');
  });

  it('never renders a Links block for a type encodeTask (and friends) cannot carry one on', async () => {
    // `renderLinkBlock` is only ever passed to `encodeProject` — the other six
    // encoders have no `links` parameter at all. `linksByRef` is still built
    // generically for every type, so this is the one place that gap would show
    // up if a future edit wired one of them up incompletely.
    const collected = await collectVaultNotes(SCOPE);

    expect(collectedFor(collected, 'task').note.body).not.toContain('## Links');
  });

  it('does not draw a link on a row neither end of it refers to', async () => {
    // Only project_1 and project_2 appear in `LINK`; nothing else should
    // mention the area, goal, entity, review, document or thought.
    const collected = await collectVaultNotes(SCOPE);

    for (const type of ['area', 'goal', 'entity', 'review', 'document', 'thought'] as const) {
      expect(collectedFor(collected, type).note.body).not.toContain('## Links');
    }
  });

  it('falls back to no links for a project that neither end of any link names', async () => {
    // `linksByRef.get('project:project_3')` misses entirely — the `?? []`
    // fallback on the `links:` line, not an empty array `linksByRef` happened
    // to store. Every test in this block also carries `LINK_ORPHAN` — a link
    // naming a task id and a project id this export never collected — which is
    // what exercises the `if (forward)` / `if (backward)` false branches: both
    // `titleByRef` lookups miss and the collector produces no entry for it
    // anywhere, this project included, rather than throwing.
    const collected = await collectVaultNotes(SCOPE);

    expect(collectedById(collected, 'project_3').note.body).not.toContain('## Links');
  });

  it('titles a thought from the first line of its content, truncated for the file name', async () => {
    const collected = await collectVaultNotes(SCOPE);

    expect(collectedFor(collected, 'thought').title).toBe(
      'What if capture worked from the lock screen'
    );
  });

  it('encodes an entity, a review and a document with their own type-specific fields', async () => {
    const collected = await collectVaultNotes(SCOPE);

    expect(collectedFor(collected, 'entity').note.frontmatter).toMatchObject({
      title: 'Dana',
      kind: 'person',
    });
    expect(collectedFor(collected, 'review').note.frontmatter).toMatchObject({ title: 'Week 31' });
    expect(collectedFor(collected, 'document').note.body).toContain('contract.pdf');
  });
});
