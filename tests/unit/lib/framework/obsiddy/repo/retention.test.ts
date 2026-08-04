/**
 * Unit Tests: the retention rules — the only code in Obsiddy that removes
 * things on a timer.
 *
 * Everything here fails silently by nature. A window off by a day archives a
 * note somebody wanted and reports success; a prune that matches one status too
 * many deletes a tombstone and the symptom appears weeks later as a connection
 * being suggested again; a missing vector drop degrades search recall gradually
 * as history grows, with no error anywhere. So these tests assert the `where`
 * clause and the transaction contents, not "did it run".
 *
 * **The tombstone is the one to read first.** `pruneStaleSuggestedLinks` must
 * match `status: 'suggested'` positively. The sweep excludes any pair that
 * already has a link row, so a `rejected` row is the only thing stopping the
 * same rejected suggestion returning every Sunday for the rest of the user's
 * life — and `NOT IN ['rejected']` is one careless edit away from taking them
 * all. §11 says out loud that someone will try to clean these up.
 *
 * **The archive/prune split is the product's promise.** Nothing a human wrote is
 * ever deleted by a clock. The tests assert that thoughts, tasks, projects,
 * goals and reviews reach `updateMany` and never `deleteMany`, and that the
 * three prune rules reach `deleteMany` and never touch a content table.
 *
 * Test Coverage:
 * - Clock-shifted boundaries: 91 days archives, 89 does not, at one fixed `now`
 * - "Untouched" is `updatedAt`, with the indexed `createdAt` clause alongside
 * - Archiving an embedded type drops its vectors in the SAME transaction
 * - Tasks and reviews archive with no vector delete — they carry no embeddings
 * - Every archive writes one `archived` event carrying the reason
 * - Closed projects cascade to their live tasks under `project_closed`
 * - Goals age from `targetDate` + one horizon period; `life` never ages out
 * - A goal with no `targetDate` is never archived by the clock
 * - `rejected` and `accepted` links survive; only untouched `suggested` prune
 * - Only `plan` time blocks prune — `actual` and `calendar` are history
 * - Every rule caps at `RETENTION_BATCH` and reports `capped`
 * - `dryRun` runs the same query and writes nothing
 *
 * @see lib/framework/obsiddy/repo/retention.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    $transaction: vi.fn(),
    obsiddyThought: { findMany: vi.fn(), updateMany: vi.fn() },
    obsiddyTask: { findMany: vi.fn(), updateMany: vi.fn() },
    obsiddyProject: { findMany: vi.fn(), updateMany: vi.fn() },
    obsiddyGoal: { findMany: vi.fn(), updateMany: vi.fn() },
    obsiddyReview: { findMany: vi.fn(), updateMany: vi.fn() },
    obsiddyLink: { findMany: vi.fn(), deleteMany: vi.fn() },
    obsiddyEvent: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    obsiddyTimeBlock: { findMany: vi.fn(), deleteMany: vi.fn() },
    obsiddyBoardCard: { findMany: vi.fn(), deleteMany: vi.fn() },
    obsiddyEmbedding: { deleteMany: vi.fn() },
  },
}));

import { prisma } from '@/lib/db/client';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import {
  archiveAgedClosedProjects,
  archiveAgedCompletedTasks,
  archiveAgedGoals,
  archiveAgedInboxThoughts,
  archiveAgedReviews,
  daysBefore,
  pruneAgedEvents,
  pruneCardsForArchivedTasks,
  prunePastPlanTimeBlocks,
  pruneStaleSuggestedLinks,
  RETENTION_BATCH,
} from '@/lib/framework/obsiddy/repo/retention';

// Minted, never cast — `OwnerScope` is branded so that `rg 'ownerScope\('` is
// the complete list of trust boundaries, and a test that fakes it leaves it.
const SCOPE = ownerScope('user_a');

/** One fixed instant. Every window below is measured from exactly this. */
const NOW = new Date('2026-08-05T09:00:00.000Z');

function rows(count: number): Array<{ id: string }> {
  return Array.from({ length: count }, (_, index) => ({ id: `row_${index}` }));
}

/** The `where` a `findMany` was called with. */
function whereOf(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const [args] = mock.mock.calls[0] as [{ where: Record<string, unknown> }];
  return args.where;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.$transaction).mockResolvedValue([]);
  for (const model of [
    prisma.obsiddyThought,
    prisma.obsiddyTask,
    prisma.obsiddyProject,
    prisma.obsiddyGoal,
    prisma.obsiddyReview,
    prisma.obsiddyLink,
    prisma.obsiddyEvent,
    prisma.obsiddyTimeBlock,
    prisma.obsiddyBoardCard,
  ]) {
    vi.mocked(model.findMany).mockResolvedValue([]);
  }
});

describe('archiveAgedInboxThoughts', () => {
  it('measures the window from a fixed now, so a batch cannot straddle midnight', async () => {
    await archiveAgedInboxThoughts(SCOPE, 90, { now: NOW });

    const where = whereOf(vi.mocked(prisma.obsiddyThought.findMany));
    expect(where.userId).toBe('user_a');
    expect(where.status).toBe('inbox');
    // Already-archived rows are excluded, which is what makes a second pass over
    // the same brain — two instances racing, a restart re-arming the job — find
    // an empty batch instead of re-archiving and re-eventing everything.
    expect(where.archivedAt).toBeNull();
    expect(where.updatedAt).toEqual({ lt: daysBefore(NOW, 90) });
  });

  it('filters on updatedAt AND createdAt — "untouched", narrowed by the index', async () => {
    // `updatedAt` is the honest test of untouched; `createdAt` is the half the
    // `[userId, status, createdAt]` index covers. Dropping the second turns this
    // into a scan of every inbox thought the user has ever written.
    await archiveAgedInboxThoughts(SCOPE, 90, { now: NOW });

    const where = whereOf(vi.mocked(prisma.obsiddyThought.findMany));
    expect(where.createdAt).toEqual({ lt: daysBefore(NOW, 90) });
    expect(where.updatedAt).toEqual({ lt: daysBefore(NOW, 90) });
  });

  it('archives a 91-day-old thought and leaves an 89-day-old one', async () => {
    // The plan's clock-shifted assertion (§16.1c), expressed against the cutoff
    // the query actually carries rather than against a live database.
    await archiveAgedInboxThoughts(SCOPE, 90, { now: NOW });

    const where = whereOf(vi.mocked(prisma.obsiddyThought.findMany));
    const cutoff = (where.updatedAt as { lt: Date }).lt;

    const ninetyOne = daysBefore(NOW, 91);
    const eightyNine = daysBefore(NOW, 89);

    expect(ninetyOne.getTime()).toBeLessThan(cutoff.getTime());
    expect(eightyNine.getTime()).toBeGreaterThan(cutoff.getTime());
  });

  it('drops the vectors in the same transaction as the stamp', async () => {
    // Not after it. An archived row still in the vector index for even a moment
    // is an archived row that turns up in search (§17 risk 5b), and the damage
    // shows up as recall quietly degrading rather than as an error.
    vi.mocked(prisma.obsiddyThought.findMany).mockResolvedValue(rows(3) as never);

    await archiveAgedInboxThoughts(SCOPE, 90, { now: NOW });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.obsiddyEmbedding.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: 'user_a',
        entityType: 'thought',
        entityId: { in: ['row_0', 'row_1', 'row_2'] },
      },
    });
  });

  it('nulls indexedHash so a restore re-embeds', async () => {
    vi.mocked(prisma.obsiddyThought.findMany).mockResolvedValue(rows(1) as never);

    await archiveAgedInboxThoughts(SCOPE, 90, { now: NOW });

    const [args] = vi.mocked(prisma.obsiddyThought.updateMany).mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(args.data).toMatchObject({ archivedReason: 'aged_out', indexedHash: null });
  });

  it('writes one archived event per row, carrying the reason', async () => {
    // This is what lets the weekly review say "47 notes aged out" with an
    // ordinary `listEvents({ kind: 'archived' })` rather than a second table.
    vi.mocked(prisma.obsiddyThought.findMany).mockResolvedValue(rows(2) as never);

    await archiveAgedInboxThoughts(SCOPE, 90, { now: NOW });

    expect(prisma.obsiddyEvent.createMany).toHaveBeenCalledWith({
      data: [
        {
          userId: 'user_a',
          kind: 'archived',
          entityType: 'thought',
          entityId: 'row_0',
          metadata: { reason: 'aged_out' },
        },
        {
          userId: 'user_a',
          kind: 'archived',
          entityType: 'thought',
          entityId: 'row_1',
          metadata: { reason: 'aged_out' },
        },
      ],
    });
  });

  it('never deletes a thought — ageing out means archiving', async () => {
    vi.mocked(prisma.obsiddyThought.findMany).mockResolvedValue(rows(5) as never);

    await archiveAgedInboxThoughts(SCOPE, 90, { now: NOW });

    expect(prisma.obsiddyThought.updateMany).toHaveBeenCalled();
    expect(
      (prisma.obsiddyThought as unknown as Record<string, unknown>).deleteMany
    ).toBeUndefined();
  });

  it('caps at the batch size and says so', async () => {
    vi.mocked(prisma.obsiddyThought.findMany).mockResolvedValue(rows(RETENTION_BATCH) as never);

    const result = await archiveAgedInboxThoughts(SCOPE, 90, { now: NOW });

    expect(result).toEqual({ count: RETENTION_BATCH, capped: true });
    const [args] = vi.mocked(prisma.obsiddyThought.findMany).mock.calls[0] as [{ take: number }];
    expect(args.take).toBe(RETENTION_BATCH);
  });

  it('reports capped: false for a partial batch', async () => {
    vi.mocked(prisma.obsiddyThought.findMany).mockResolvedValue(rows(3) as never);

    const result = await archiveAgedInboxThoughts(SCOPE, 90, { now: NOW });

    expect(result).toEqual({ count: 3, capped: false });
  });

  it('writes nothing on a dry run, having asked the same question', async () => {
    vi.mocked(prisma.obsiddyThought.findMany).mockResolvedValue(rows(4) as never);

    const result = await archiveAgedInboxThoughts(SCOPE, 90, { now: NOW, dryRun: true });

    expect(result.count).toBe(4);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.obsiddyThought.updateMany).not.toHaveBeenCalled();
  });
});

describe('archiveAgedCompletedTasks', () => {
  it('measures from completedAt, not createdAt', async () => {
    // A task created two years ago and finished yesterday is not old.
    await archiveAgedCompletedTasks(SCOPE, 180, { now: NOW });

    const where = whereOf(vi.mocked(prisma.obsiddyTask.findMany));
    expect(where.status).toBe('done');
    expect(where.completedAt).toEqual({ lt: daysBefore(NOW, 180) });
    expect(where.createdAt).toBeUndefined();
  });

  it('drops no vectors — tasks are deliberately not embedded', async () => {
    vi.mocked(prisma.obsiddyTask.findMany).mockResolvedValue(rows(2) as never);

    await archiveAgedCompletedTasks(SCOPE, 180, { now: NOW });

    expect(prisma.obsiddyTask.updateMany).toHaveBeenCalled();
    expect(prisma.obsiddyEmbedding.deleteMany).not.toHaveBeenCalled();
  });
});

describe('archiveAgedClosedProjects', () => {
  it('selects on closedAt and both closed statuses', async () => {
    await archiveAgedClosedProjects(SCOPE, 180, { now: NOW });

    const where = whereOf(vi.mocked(prisma.obsiddyProject.findMany));
    expect(where.status).toEqual({ in: ['done', 'abandoned'] });
    expect(where.closedAt).toEqual({ lt: daysBefore(NOW, 180) });
  });

  it('cascade-archives the project’s live tasks under project_closed', async () => {
    // Left alone, a finished project's forty tasks stay in Today, in the ranked
    // list and in the agent's context — attached to something explicitly done.
    vi.mocked(prisma.obsiddyProject.findMany).mockResolvedValue([{ id: 'proj_1' }] as never);
    vi.mocked(prisma.obsiddyTask.findMany).mockResolvedValue(rows(4) as never);

    const result = await archiveAgedClosedProjects(SCOPE, 180, { now: NOW });

    expect(result.cascadedTasks).toBe(4);
    const taskWhere = whereOf(vi.mocked(prisma.obsiddyTask.findMany));
    expect(taskWhere).toMatchObject({ userId: 'user_a', archivedAt: null });
    expect(taskWhere.projectId).toEqual({ in: ['proj_1'] });

    const [taskUpdate] = vi.mocked(prisma.obsiddyTask.updateMany).mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    // A distinct reason, so a restore later can tell "old" from "its project
    // was closed" rather than having the two blur into one word.
    expect(taskUpdate.data).toMatchObject({ archivedReason: 'project_closed' });
  });

  it('counts the cascade on a dry run without writing', async () => {
    vi.mocked(prisma.obsiddyProject.findMany).mockResolvedValue([{ id: 'proj_1' }] as never);
    vi.mocked(prisma.obsiddyTask.findMany).mockResolvedValue(rows(7) as never);

    const result = await archiveAgedClosedProjects(SCOPE, 180, { now: NOW, dryRun: true });

    expect(result).toMatchObject({ count: 1, cascadedTasks: 7 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('does no task query at all when no project aged out', async () => {
    const result = await archiveAgedClosedProjects(SCOPE, 180, { now: NOW });

    expect(result).toEqual({ count: 0, capped: false, cascadedTasks: 0 });
    expect(prisma.obsiddyTask.findMany).not.toHaveBeenCalled();
  });
});

describe('archiveAgedGoals', () => {
  it('ages each horizon by one of its own periods, and never ages a life goal', async () => {
    await archiveAgedGoals(SCOPE, { now: NOW });

    const where = whereOf(vi.mocked(prisma.obsiddyGoal.findMany));
    expect(where.status).toEqual({ in: ['achieved', 'dropped'] });

    const branches = where.OR as Array<{ horizon: string; targetDate: { lt: Date } }>;
    const byHorizon = Object.fromEntries(branches.map((b) => [b.horizon, b.targetDate.lt]));

    expect(Object.keys(byHorizon).sort()).toEqual(['month', 'quarter', 'week', 'year']);
    // One period of a life goal is a life. Any number here would archive the
    // most important rows in the brain on a schedule.
    expect(byHorizon.life).toBeUndefined();

    expect(byHorizon.week).toEqual(daysBefore(NOW, 7));
    expect(byHorizon.quarter).toEqual(daysBefore(NOW, 91));
    expect(byHorizon.year).toEqual(daysBefore(NOW, 365));
  });

  it('never matches a goal with no target date', async () => {
    // Every branch requires `targetDate: { lt: ... }`, which a null cannot
    // satisfy. `updatedAt` would be the tempting substitute and is wrong: it
    // moves when a child is re-parented, so it measures editing, not intent.
    await archiveAgedGoals(SCOPE, { now: NOW });

    const where = whereOf(vi.mocked(prisma.obsiddyGoal.findMany));
    const branches = where.OR as Array<Record<string, unknown>>;
    for (const branch of branches) {
      expect(branch.targetDate).toHaveProperty('lt');
    }
  });
});

describe('archiveAgedReviews', () => {
  it('measures from generatedAt and drops no vectors', async () => {
    vi.mocked(prisma.obsiddyReview.findMany).mockResolvedValue(rows(1) as never);

    await archiveAgedReviews(SCOPE, 730, { now: NOW });

    const where = whereOf(vi.mocked(prisma.obsiddyReview.findMany));
    expect(where.generatedAt).toEqual({ lt: daysBefore(NOW, 730) });
    expect(prisma.obsiddyEmbedding.deleteMany).not.toHaveBeenCalled();
  });
});

describe('pruneStaleSuggestedLinks — the tombstone rule', () => {
  it('matches status "suggested" positively, never "not rejected"', async () => {
    // The single most important assertion in this file. A `rejected` row is the
    // only thing stopping the sweep re-proposing a pair the user has already
    // turned down — for ever, every Sunday, with no way to make it stop.
    await pruneStaleSuggestedLinks(SCOPE, 60, { now: NOW });

    const where = whereOf(vi.mocked(prisma.obsiddyLink.findMany));
    expect(where.status).toBe('suggested');
    expect(where.NOT).toBeUndefined();
    expect(JSON.stringify(where)).not.toContain('rejected');
  });

  it('spares any link somebody has looked at', async () => {
    await pruneStaleSuggestedLinks(SCOPE, 60, { now: NOW });

    const where = whereOf(vi.mocked(prisma.obsiddyLink.findMany));
    expect(where.reviewedAt).toBeNull();
    expect(where.createdAt).toEqual({ lt: daysBefore(NOW, 60) });
  });

  it('deletes rather than archives — a suggestion is regenerable', async () => {
    vi.mocked(prisma.obsiddyLink.findMany).mockResolvedValue(rows(3) as never);

    const result = await pruneStaleSuggestedLinks(SCOPE, 60, { now: NOW });

    expect(result.count).toBe(3);
    expect(prisma.obsiddyLink.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user_a', id: { in: ['row_0', 'row_1', 'row_2'] } },
    });
    // Derived data, so no event and no vector work.
    expect(prisma.obsiddyEvent.createMany).not.toHaveBeenCalled();
  });

  it('deletes nothing on a dry run', async () => {
    vi.mocked(prisma.obsiddyLink.findMany).mockResolvedValue(rows(3) as never);

    await pruneStaleSuggestedLinks(SCOPE, 60, { now: NOW, dryRun: true });

    expect(prisma.obsiddyLink.deleteMany).not.toHaveBeenCalled();
  });
});

describe('pruneAgedEvents', () => {
  it('prunes past the window, scoped to the owner', async () => {
    vi.mocked(prisma.obsiddyEvent.findMany).mockResolvedValue(rows(2) as never);

    await pruneAgedEvents(SCOPE, 400, { now: NOW });

    const where = whereOf(vi.mocked(prisma.obsiddyEvent.findMany));
    expect(where).toEqual({ userId: 'user_a', createdAt: { lt: daysBefore(NOW, 400) } });
    expect(prisma.obsiddyEvent.deleteMany).toHaveBeenCalled();
  });

  it('selects ids first rather than issuing an unbounded deleteMany', async () => {
    // The highest-volume table by a distance. An unbounded delete on it inside a
    // tick with a 60-second budget is how one brain's cleanup starves everyone
    // else's turn.
    await pruneAgedEvents(SCOPE, 400, { now: NOW });

    const [args] = vi.mocked(prisma.obsiddyEvent.findMany).mock.calls[0] as [{ take: number }];
    expect(args.take).toBe(RETENTION_BATCH);
  });
});

describe('prunePastPlanTimeBlocks', () => {
  it('takes only plan blocks — actual and calendar are history, not intentions', async () => {
    vi.mocked(prisma.obsiddyTimeBlock.findMany).mockResolvedValue(rows(1) as never);

    await prunePastPlanTimeBlocks(SCOPE, 90, { now: NOW });

    const where = whereOf(vi.mocked(prisma.obsiddyTimeBlock.findMany));
    expect(where.source).toBe('plan');
    // `endAt`, not `startAt`: a block is past when it has finished.
    expect(where.endAt).toEqual({ lt: daysBefore(NOW, 90) });
  });
});

describe('pruneCardsForArchivedTasks', () => {
  it('removes cards whose task is archived, so a board holds no ghosts', async () => {
    // The FK cascades on delete, and archiving is deliberately not a delete —
    // so without this rule every task retention archives leaves a card behind.
    vi.mocked(prisma.obsiddyBoardCard.findMany).mockResolvedValue(rows(2) as never);

    const result = await pruneCardsForArchivedTasks(SCOPE, { now: NOW });

    expect(result.count).toBe(2);
    const where = whereOf(vi.mocked(prisma.obsiddyBoardCard.findMany));
    expect(where).toEqual({ userId: 'user_a', task: { archivedAt: { not: null } } });
    expect(prisma.obsiddyBoardCard.deleteMany).toHaveBeenCalled();
  });

  it('has no window — it is a consequence of the archive rules, not a clock', async () => {
    await pruneCardsForArchivedTasks(SCOPE, { now: NOW });

    const where = whereOf(vi.mocked(prisma.obsiddyBoardCard.findMany));
    expect(where.createdAt).toBeUndefined();
  });
});
