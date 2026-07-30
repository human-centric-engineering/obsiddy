/**
 * Unit Tests: the connection engine (Release 1, phase 4).
 *
 * Three properties, each invisible when it breaks:
 *
 *   1. **The sweep costs no tokens.** It reads stored vectors (D4). If it ever
 *      started embedding, nothing would fail — the bill would just grow.
 *   2. **A→B and B→A are one connection.** The unique index is directional, so
 *      without collapsing them the user sees the same pair twice.
 *   3. **Caps are reported, not silent.** A sweep that examined 200 of 900
 *      projects must not read as "there are no more connections".
 *
 * @see lib/framework/obsiddy/search/connections.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const nearestNeighbourRows = vi.fn();
const listEmbeddedEntityIds = vi.fn();
const createSuggestedLinks = vi.fn();
const embedBatch = vi.fn();
const embedText = vi.fn();

vi.mock('@/lib/framework/obsiddy/repo/embeddings', () => ({
  nearestNeighbourRows: (...args: unknown[]) => nearestNeighbourRows(...args),
  listEmbeddedEntityIds: (...args: unknown[]) => listEmbeddedEntityIds(...args),
}));

vi.mock('@/lib/framework/obsiddy/repo/links', () => ({
  createSuggestedLinks: (...args: unknown[]) => createSuggestedLinks(...args),
}));

vi.mock('@/lib/orchestration/knowledge/embedder', () => ({
  embedBatch: (...args: unknown[]) => embedBatch(...args),
  embedText: (...args: unknown[]) => embedText(...args),
}));

import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import {
  findConnections,
  STRENGTH_FLOOR,
  sweepConnections,
} from '@/lib/framework/obsiddy/search/connections';

const SCOPE = ownerScope('user_a');
const NOW = new Date('2026-07-29T12:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  listEmbeddedEntityIds.mockResolvedValue([]);
  nearestNeighbourRows.mockResolvedValue([]);
  createSuggestedLinks.mockResolvedValue(0);
});

describe('findConnections', () => {
  it('converts cosine distance to similarity', () => {
    nearestNeighbourRows.mockResolvedValue([
      { entityType: 'goal', entityId: 'g_1', distance: 0.2 },
    ]);

    return findConnections({ scope: SCOPE, entityType: 'project', entityId: 'p_1' }).then(
      (found) => {
        expect(found).toEqual([
          {
            sourceType: 'project',
            sourceId: 'p_1',
            targetType: 'goal',
            targetId: 'g_1',
            strength: 0.8,
          },
        ]);
      }
    );
  });

  it('asks the database for the 0.72 floor as a distance ceiling', async () => {
    await findConnections({ scope: SCOPE, entityType: 'project', entityId: 'p_1' });

    expect(nearestNeighbourRows).toHaveBeenCalledWith(
      SCOPE,
      expect.objectContaining({ maxDistance: 1 - STRENGTH_FLOOR })
    );
  });

  it('honours a caller-supplied floor, for the wider ideation pass', async () => {
    await findConnections({
      scope: SCOPE,
      entityType: 'project',
      entityId: 'p_1',
      strengthFloor: 0.5,
    });

    expect(nearestNeighbourRows).toHaveBeenCalledWith(
      SCOPE,
      expect.objectContaining({ maxDistance: 0.5 })
    );
  });

  it('spends no embedding tokens — it reads stored vectors (D4)', async () => {
    nearestNeighbourRows.mockResolvedValue([
      { entityType: 'goal', entityId: 'g_1', distance: 0.1 },
    ]);

    await findConnections({ scope: SCOPE, entityType: 'project', entityId: 'p_1' });

    expect(embedText).not.toHaveBeenCalled();
    expect(embedBatch).not.toHaveBeenCalled();
  });

  it('is read-only, so it is safe to call repeatedly from an agent', async () => {
    nearestNeighbourRows.mockResolvedValue([
      { entityType: 'goal', entityId: 'g_1', distance: 0.1 },
    ]);

    await findConnections({ scope: SCOPE, entityType: 'project', entityId: 'p_1' });

    expect(createSuggestedLinks).not.toHaveBeenCalled();
  });

  it('returns nothing for an entity with no stored vector yet', async () => {
    // Freshly captured, not yet indexed. "Ask again after the next pass" — not an
    // error.
    nearestNeighbourRows.mockResolvedValue([]);

    await expect(
      findConnections({ scope: SCOPE, entityType: 'thought', entityId: 't_new' })
    ).resolves.toEqual([]);
  });
});

describe('sweepConnections', () => {
  it('spends no embedding tokens across the whole sweep', async () => {
    listEmbeddedEntityIds.mockResolvedValue(['p_1']);
    nearestNeighbourRows.mockResolvedValue([
      { entityType: 'goal', entityId: 'g_1', distance: 0.2 },
    ]);

    await sweepConnections(SCOPE, NOW);

    expect(embedText).not.toHaveBeenCalled();
    expect(embedBatch).not.toHaveBeenCalled();
  });

  it('writes suggestions as origin:rule / status:suggested, never accepted', async () => {
    // A swept pair is the machine's guess. The scorer's goalAlignment walk follows
    // ACCEPTED links only, so a suggestion must not be able to move a task up the
    // ranking before a human agrees with it (§10).
    listEmbeddedEntityIds.mockImplementation((_scope: unknown, type: string) =>
      Promise.resolve(type === 'project' ? ['p_1'] : [])
    );
    nearestNeighbourRows.mockResolvedValue([
      { entityType: 'goal', entityId: 'g_1', distance: 0.2 },
    ]);

    await sweepConnections(SCOPE, NOW);

    expect(createSuggestedLinks).toHaveBeenCalledWith(SCOPE, [
      expect.objectContaining({
        sourceType: 'project',
        sourceId: 'p_1',
        targetType: 'goal',
        targetId: 'g_1',
        kind: 'relates_to',
        origin: 'rule',
        status: 'suggested',
        strength: 0.8,
      }),
    ]);
  });

  it('collapses A→B and B→A into one row, keeping the stronger reading', async () => {
    listEmbeddedEntityIds.mockImplementation((_scope: unknown, type: string) =>
      Promise.resolve(type === 'project' ? ['p_1', 'p_2'] : [])
    );
    nearestNeighbourRows.mockImplementation((_scope: unknown, input: { entityId: string }) =>
      Promise.resolve(
        input.entityId === 'p_1'
          ? [{ entityType: 'project', entityId: 'p_2', distance: 0.25 }]
          : [{ entityType: 'project', entityId: 'p_1', distance: 0.2 }]
      )
    );

    const result = await sweepConnections(SCOPE, NOW);

    // Both directions surfaced as candidates...
    expect(result.candidates).toBe(2);
    // ...but only one row is written, at the better of the two strengths.
    const written = createSuggestedLinks.mock.calls[0][1];
    expect(written).toHaveLength(1);
    expect(written[0].strength).toBeCloseTo(0.8);
  });

  it('bounds the thought pass to a 180-day window', async () => {
    // Pair count is quadratic in thoughts. The window is what keeps it linear in
    // practice — and a three-year-old thought resurfacing is usually noise anyway.
    listEmbeddedEntityIds.mockImplementation((_scope: unknown, type: string) =>
      Promise.resolve(type === 'thought' ? ['t_1'] : [])
    );

    await sweepConnections(SCOPE, NOW);

    const thoughtCall = listEmbeddedEntityIds.mock.calls.find((call) => call[1] === 'thought');
    const since = thoughtCall?.[3] as Date;

    expect(since).toBeInstanceOf(Date);
    const days = Math.round((NOW.getTime() - since.getTime()) / (24 * 60 * 60 * 1000));
    expect(days).toBe(180);

    // And the neighbour query carries the same window.
    expect(nearestNeighbourRows).toHaveBeenCalledWith(
      SCOPE,
      expect.objectContaining({ entityType: 'thought', since })
    );
  });

  it('sweeps thought→thought, which is where article ideas come from', async () => {
    listEmbeddedEntityIds.mockImplementation((_scope: unknown, type: string) =>
      Promise.resolve(type === 'thought' ? ['t_1'] : [])
    );

    await sweepConnections(SCOPE, NOW);

    const call = nearestNeighbourRows.mock.calls.find((c) => c[1].entityType === 'thought');
    expect(call?.[1].targetTypes).toContain('thought');
  });

  it('reports which types hit the source cap rather than truncating silently', async () => {
    // 200 is the per-type cap. A sweep that stopped looking must say so.
    listEmbeddedEntityIds.mockImplementation((_scope: unknown, type: string) =>
      Promise.resolve(type === 'project' ? Array.from({ length: 200 }, (_, i) => `p_${i}`) : [])
    );

    const result = await sweepConnections(SCOPE, NOW);

    expect(result.cappedTypes).toContain('project');
    expect(result.examined).toBe(200);
  });

  it('reports no cap when every entity fitted', async () => {
    listEmbeddedEntityIds.mockImplementation((_scope: unknown, type: string) =>
      Promise.resolve(type === 'project' ? ['p_1', 'p_2'] : [])
    );

    const result = await sweepConnections(SCOPE, NOW);

    expect(result.cappedTypes).toEqual([]);
  });

  it('writes nothing when no pair clears the floor', async () => {
    listEmbeddedEntityIds.mockResolvedValue(['p_1']);
    nearestNeighbourRows.mockResolvedValue([]);

    const result = await sweepConnections(SCOPE, NOW);

    expect(createSuggestedLinks).toHaveBeenCalledWith(SCOPE, []);
    expect(result.created).toBe(0);
  });
});
