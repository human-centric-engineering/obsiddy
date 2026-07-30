/**
 * Unit Tests: the summaries repo — hydration for search results, the keyword
 * fallback, and the link-endpoint existence check (Release 1, phase 4).
 *
 * Two behaviours matter beyond "does it call the right table":
 *
 *   - **A thought has no title.** The first ~80 characters of its content
 *     become one, via `excerpt()` — inventing a title would bury the only
 *     useful text.
 *   - **`excerpt()` truncates on a word boundary and appends an ellipsis.** A
 *     truncation that lands mid-word reads as a bug in the UI; this is what
 *     stops that.
 *
 * @see lib/framework/obsiddy/repo/summaries.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

function delegate() {
  return {
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
  };
}

vi.mock('@/lib/db/client', () => ({
  prisma: {
    obsiddyThought: delegate(),
    obsiddyProject: delegate(),
    obsiddyGoal: delegate(),
    obsiddyArea: delegate(),
    obsiddyEntity: delegate(),
    obsiddyDocument: delegate(),
    obsiddyTask: delegate(),
  },
}));

import { prisma } from '@/lib/db/client';
import {
  entityExists,
  findSummaries,
  keywordSummaries,
} from '@/lib/framework/obsiddy/repo/summaries';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';

const SCOPE = ownerScope('user_a');
const UPDATED_AT = new Date('2026-01-01T00:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('findSummaries: scoping and the empty-ids short circuit', () => {
  it('returns [] without querying when ids is empty', async () => {
    const result = await findSummaries(SCOPE, 'project', []);

    expect(result).toEqual([]);
    expect(prisma.obsiddyProject.findMany).not.toHaveBeenCalled();
  });

  it('scopes the query to the owner and filters to the given ids', async () => {
    vi.mocked(prisma.obsiddyProject.findMany).mockResolvedValue([]);

    await findSummaries(SCOPE, 'project', ['p_1', 'p_2']);

    const call = vi.mocked(prisma.obsiddyProject.findMany).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ userId: 'user_a', id: { in: ['p_1', 'p_2'] } });
  });

  it('excludes archived rows by default', async () => {
    await findSummaries(SCOPE, 'project', ['p_1']);

    const call = vi.mocked(prisma.obsiddyProject.findMany).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ archivedAt: null });
  });

  it('includes archived rows when includeArchived is true', async () => {
    await findSummaries(SCOPE, 'project', ['p_1'], true);

    const call = vi.mocked(prisma.obsiddyProject.findMany).mock.calls[0]?.[0];
    expect(call?.where).not.toHaveProperty('archivedAt');
  });
});

describe('findSummaries: thought — no title field, so content becomes one', () => {
  it('uses the first ~80 characters of content as the title, full words never cut', async () => {
    const content = `${Array(40).fill('word').join(' ')}. Extra tail text that will be cut.`;
    vi.mocked(prisma.obsiddyThought.findMany).mockResolvedValue([
      { id: 't_1', content, archivedAt: null, updatedAt: UPDATED_AT },
    ] as never);

    const [summary] = await findSummaries(SCOPE, 'thought', ['t_1']);

    expect(summary.entityType).toBe('thought');
    expect(summary.title.endsWith('…')).toBe(true);
    expect(summary.title.length).toBeLessThan(content.length);
    // Truncated on a word boundary: nothing before the ellipsis is a fragment
    // of a longer word from the source text.
    const titleBody = summary.title.slice(0, -1);
    for (const word of titleBody.split(' ')) {
      expect(content).toContain(word);
    }
  });

  it('falls back to "Untitled thought" when content is empty', async () => {
    vi.mocked(prisma.obsiddyThought.findMany).mockResolvedValue([
      { id: 't_1', content: '', archivedAt: null, updatedAt: UPDATED_AT },
    ] as never);

    const [summary] = await findSummaries(SCOPE, 'thought', ['t_1']);

    expect(summary.title).toBe('Untitled thought');
  });

  it('falls back to "Untitled thought" when content is only whitespace', async () => {
    vi.mocked(prisma.obsiddyThought.findMany).mockResolvedValue([
      { id: 't_1', content: '   ', archivedAt: null, updatedAt: UPDATED_AT },
    ] as never);

    const [summary] = await findSummaries(SCOPE, 'thought', ['t_1']);

    expect(summary.title).toBe('Untitled thought');
  });

  it('uses the whole trimmed content, untruncated, when it is short', async () => {
    vi.mocked(prisma.obsiddyThought.findMany).mockResolvedValue([
      { id: 't_1', content: '  Call the accountant  ', archivedAt: null, updatedAt: UPDATED_AT },
    ] as never);

    const [summary] = await findSummaries(SCOPE, 'thought', ['t_1']);

    expect(summary.title).toBe('Call the accountant');
    expect(summary.subtitle).toBe('Call the accountant');
  });
});

describe('findSummaries: excerpt() truncation and fallbacks, per type', () => {
  it('project: excerpts the description when present', async () => {
    const description = `${Array(60).fill('word').join(' ')} tail overflow text`;
    vi.mocked(prisma.obsiddyProject.findMany).mockResolvedValue([
      {
        id: 'p_1',
        name: 'Launch',
        description,
        status: 'active',
        archivedAt: null,
        updatedAt: UPDATED_AT,
      },
    ] as never);

    const [summary] = await findSummaries(SCOPE, 'project', ['p_1']);

    expect(summary.title).toBe('Launch');
    expect(summary.subtitle?.endsWith('…')).toBe(true);
  });

  it('project: falls back to status when description is null', async () => {
    vi.mocked(prisma.obsiddyProject.findMany).mockResolvedValue([
      {
        id: 'p_1',
        name: 'Launch',
        description: null,
        status: 'paused',
        archivedAt: null,
        updatedAt: UPDATED_AT,
      },
    ] as never);

    const [summary] = await findSummaries(SCOPE, 'project', ['p_1']);

    expect(summary.subtitle).toBe('paused');
  });

  it('goal: falls back to "{horizon} goal" when description is null', async () => {
    vi.mocked(prisma.obsiddyGoal.findMany).mockResolvedValue([
      {
        id: 'g_1',
        title: 'Get fit',
        description: null,
        horizon: 'year',
        archivedAt: null,
        updatedAt: UPDATED_AT,
      },
    ] as never);

    const [summary] = await findSummaries(SCOPE, 'goal', ['g_1']);

    expect(summary.title).toBe('Get fit');
    expect(summary.subtitle).toBe('year goal');
  });

  it('area: has no fallback — subtitle is null when description is null', async () => {
    vi.mocked(prisma.obsiddyArea.findMany).mockResolvedValue([
      { id: 'a_1', name: 'Health', description: null, archivedAt: null, updatedAt: UPDATED_AT },
    ] as never);

    const [summary] = await findSummaries(SCOPE, 'area', ['a_1']);

    expect(summary.title).toBe('Health');
    expect(summary.subtitle).toBeNull();
  });

  it('entity: falls back to kind when description is null', async () => {
    vi.mocked(prisma.obsiddyEntity.findMany).mockResolvedValue([
      {
        id: 'e_1',
        name: 'Acme Corp',
        description: null,
        kind: 'company',
        archivedAt: null,
        updatedAt: UPDATED_AT,
      },
    ] as never);

    const [summary] = await findSummaries(SCOPE, 'entity', ['e_1']);

    expect(summary.title).toBe('Acme Corp');
    expect(summary.subtitle).toBe('company');
  });

  it('document: subtitle is always the file name, never excerpted text', async () => {
    vi.mocked(prisma.obsiddyDocument.findMany).mockResolvedValue([
      {
        id: 'd_1',
        title: 'Q4 Plan',
        fileName: 'q4-plan.pdf',
        archivedAt: null,
        updatedAt: UPDATED_AT,
      },
    ] as never);

    const [summary] = await findSummaries(SCOPE, 'document', ['d_1']);

    expect(summary.title).toBe('Q4 Plan');
    expect(summary.subtitle).toBe('q4-plan.pdf');
  });

  it('task: falls back to status when notes is null', async () => {
    vi.mocked(prisma.obsiddyTask.findMany).mockResolvedValue([
      {
        id: 'k_1',
        title: 'Ship it',
        notes: null,
        status: 'doing',
        archivedAt: null,
        updatedAt: UPDATED_AT,
      },
    ] as never);

    const [summary] = await findSummaries(SCOPE, 'task', ['k_1']);

    expect(summary.title).toBe('Ship it');
    expect(summary.subtitle).toBe('doing');
  });

  it('task: excerpts notes when present, rather than falling back to status', async () => {
    vi.mocked(prisma.obsiddyTask.findMany).mockResolvedValue([
      {
        id: 'k_1',
        title: 'Ship it',
        notes: 'Remember the release notes',
        status: 'doing',
        archivedAt: null,
        updatedAt: UPDATED_AT,
      },
    ] as never);

    const [summary] = await findSummaries(SCOPE, 'task', ['k_1']);

    expect(summary.subtitle).toBe('Remember the release notes');
  });
});

describe('keywordSummaries: per-type search fields', () => {
  it('thought: matches on content only, then hydrates via findSummaries', async () => {
    vi.mocked(prisma.obsiddyThought.findMany)
      .mockResolvedValueOnce([{ id: 't_1' }] as never)
      .mockResolvedValueOnce([
        { id: 't_1', content: 'Kestrel notes', archivedAt: null, updatedAt: UPDATED_AT },
      ] as never);

    const results = await keywordSummaries(SCOPE, 'thought', 'Kestrel', 5);

    const searchCall = vi.mocked(prisma.obsiddyThought.findMany).mock.calls[0]?.[0];
    expect(searchCall?.where).toMatchObject({
      userId: 'user_a',
      content: { contains: 'Kestrel', mode: 'insensitive' },
    });
    expect(searchCall?.take).toBe(5);
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe('Kestrel notes');
  });

  it('project: matches on name OR description', async () => {
    vi.mocked(prisma.obsiddyProject.findMany)
      .mockResolvedValueOnce([{ id: 'p_1' }] as never)
      .mockResolvedValueOnce([]);

    await keywordSummaries(SCOPE, 'project', 'launch', 10);

    const searchCall = vi.mocked(prisma.obsiddyProject.findMany).mock.calls[0]?.[0];
    expect(searchCall?.where?.OR).toEqual([
      { name: { contains: 'launch', mode: 'insensitive' } },
      { description: { contains: 'launch', mode: 'insensitive' } },
    ]);
  });

  it('goal: matches on title OR description', async () => {
    vi.mocked(prisma.obsiddyGoal.findMany)
      .mockResolvedValueOnce([{ id: 'g_1' }] as never)
      .mockResolvedValueOnce([]);

    await keywordSummaries(SCOPE, 'goal', 'fitness', 10);

    const searchCall = vi.mocked(prisma.obsiddyGoal.findMany).mock.calls[0]?.[0];
    expect(searchCall?.where?.OR).toEqual([
      { title: { contains: 'fitness', mode: 'insensitive' } },
      { description: { contains: 'fitness', mode: 'insensitive' } },
    ]);
  });

  it('area: matches on name OR description', async () => {
    vi.mocked(prisma.obsiddyArea.findMany)
      .mockResolvedValueOnce([{ id: 'a_1' }] as never)
      .mockResolvedValueOnce([]);

    await keywordSummaries(SCOPE, 'area', 'health', 10);

    const searchCall = vi.mocked(prisma.obsiddyArea.findMany).mock.calls[0]?.[0];
    expect(searchCall?.where?.OR).toEqual([
      { name: { contains: 'health', mode: 'insensitive' } },
      { description: { contains: 'health', mode: 'insensitive' } },
    ]);
  });

  it('entity: matches on name OR description', async () => {
    vi.mocked(prisma.obsiddyEntity.findMany)
      .mockResolvedValueOnce([{ id: 'e_1' }] as never)
      .mockResolvedValueOnce([]);

    await keywordSummaries(SCOPE, 'entity', 'acme', 10);

    const searchCall = vi.mocked(prisma.obsiddyEntity.findMany).mock.calls[0]?.[0];
    expect(searchCall?.where?.OR).toEqual([
      { name: { contains: 'acme', mode: 'insensitive' } },
      { description: { contains: 'acme', mode: 'insensitive' } },
    ]);
  });

  it('document: matches on title OR fileName OR extractedText', async () => {
    vi.mocked(prisma.obsiddyDocument.findMany)
      .mockResolvedValueOnce([{ id: 'd_1' }] as never)
      .mockResolvedValueOnce([]);

    await keywordSummaries(SCOPE, 'document', 'q4', 10);

    const searchCall = vi.mocked(prisma.obsiddyDocument.findMany).mock.calls[0]?.[0];
    expect(searchCall?.where?.OR).toEqual([
      { title: { contains: 'q4', mode: 'insensitive' } },
      { fileName: { contains: 'q4', mode: 'insensitive' } },
      { extractedText: { contains: 'q4', mode: 'insensitive' } },
    ]);
  });

  it('honours includeArchived on the search query itself, not only the hydration query', async () => {
    vi.mocked(prisma.obsiddyProject.findMany).mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await keywordSummaries(SCOPE, 'project', 'launch', 10, true);

    const searchCall = vi.mocked(prisma.obsiddyProject.findMany).mock.calls[0]?.[0];
    expect(searchCall?.where).not.toHaveProperty('archivedAt');
  });

  it('excludes archived rows from the search query by default', async () => {
    vi.mocked(prisma.obsiddyProject.findMany).mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await keywordSummaries(SCOPE, 'project', 'launch', 10);

    const searchCall = vi.mocked(prisma.obsiddyProject.findMany).mock.calls[0]?.[0];
    expect(searchCall?.where).toMatchObject({ archivedAt: null });
  });

  it('returns [] when nothing matches, without a wasted hydration call', async () => {
    vi.mocked(prisma.obsiddyProject.findMany).mockResolvedValueOnce([]);

    const results = await keywordSummaries(SCOPE, 'project', 'nothing', 10);

    expect(results).toEqual([]);
    // findSummaries short-circuits on empty ids, so there is only the one call.
    expect(prisma.obsiddyProject.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('entityExists', () => {
  it.each([
    ['thought', 'obsiddyThought'],
    ['project', 'obsiddyProject'],
    ['goal', 'obsiddyGoal'],
    ['area', 'obsiddyArea'],
    ['entity', 'obsiddyEntity'],
    ['document', 'obsiddyDocument'],
    ['task', 'obsiddyTask'],
  ] as const)('%s: scopes the existence check by owner and id', async (type, delegateName) => {
    const client = prisma as unknown as Record<string, { count: ReturnType<typeof vi.fn> }>;
    client[delegateName].count.mockResolvedValue(1);

    const exists = await entityExists(SCOPE, type, 'id_1');

    expect(exists).toBe(true);
    expect(client[delegateName].count).toHaveBeenCalledWith({
      where: { userId: 'user_a', id: 'id_1' },
    });
  });

  it("returns false when the count is zero — no match, or not this owner's row", async () => {
    vi.mocked(prisma.obsiddyProject.count).mockResolvedValue(0);

    await expect(entityExists(SCOPE, 'project', 'someone_elses_id')).resolves.toBe(false);
  });

  it('does not filter on archivedAt — an archived entity still exists for linking', async () => {
    vi.mocked(prisma.obsiddyProject.count).mockResolvedValue(1);

    await entityExists(SCOPE, 'project', 'id_1');

    const call = vi.mocked(prisma.obsiddyProject.count).mock.calls[0]?.[0];
    expect(call?.where).not.toHaveProperty('archivedAt');
  });
});
