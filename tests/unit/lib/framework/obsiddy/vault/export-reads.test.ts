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
 *      `ObsiddyLink` has no archive state and passing the flag would be an
 *      option the repo silently ignores.
 *   3. **Only accepted links are exported.** A proposed link is a suggestion the
 *      user has not agreed to; writing it into a note body would launder a guess
 *      into a fact that then round-trips back in as one.
 *   4. **Every read is owner-scoped.** There is no `userId` in `export.ts` and no
 *      Prisma import, so this holds by construction — asserted anyway, because
 *      "structurally impossible" stops being true the first time somebody adds a
 *      convenience read.
 *
 * @see lib/framework/obsiddy/vault/export.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/framework/obsiddy/repo/areas', () => ({ listAreas: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/checklist', () => ({ listChecklistForTasks: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/documents', () => ({ listDocuments: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/entities', () => ({ listEntities: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/goals', () => ({ listGoals: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/links', () => ({ listLinks: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/projects', () => ({ listProjects: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/reviews', () => ({ listReviews: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/tags', () => ({ listTagsForTasks: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/tasks', () => ({ listTasks: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/thoughts', () => ({ listThoughts: vi.fn() }));

import { listAreas } from '@/lib/framework/obsiddy/repo/areas';
import { listChecklistForTasks } from '@/lib/framework/obsiddy/repo/checklist';
import { listDocuments } from '@/lib/framework/obsiddy/repo/documents';
import { listEntities } from '@/lib/framework/obsiddy/repo/entities';
import { listGoals } from '@/lib/framework/obsiddy/repo/goals';
import { listLinks } from '@/lib/framework/obsiddy/repo/links';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { listProjects } from '@/lib/framework/obsiddy/repo/projects';
import { listReviews } from '@/lib/framework/obsiddy/repo/reviews';
import { listTagsForTasks } from '@/lib/framework/obsiddy/repo/tags';
import { listTasks } from '@/lib/framework/obsiddy/repo/tasks';
import { listThoughts } from '@/lib/framework/obsiddy/repo/thoughts';
import {
  buildVaultArchive,
  buildVaultExport,
  collectVaultNotes,
  VAULT_EXPORT_MAX_PER_TYPE,
  VaultExportError,
} from '@/lib/framework/obsiddy/vault/export';
import { VAULT_MANIFEST_PATH } from '@/lib/framework/obsiddy/vault/layout';

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
    expect(manifest.generator).toBe('obsiddy');
  });
});

describe('buildVaultArchive', () => {
  it('names the file from the generation date, not from anything user-supplied', async () => {
    const archive = await buildVaultArchive(SCOPE, { now: new Date('2026-08-06T09:00:00Z') });

    // The route interpolates this straight into a Content-Disposition header.
    expect(archive.fileName).toBe('obsiddy-vault-2026-08-06.zip');
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
