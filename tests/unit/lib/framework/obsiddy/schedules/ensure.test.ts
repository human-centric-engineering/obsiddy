/**
 * Unit Tests: `ensureObsiddySchedules`.
 *
 * This is what gives one person their own background workflows, and the design
 * rests on a mechanism that is easy to break without noticing: the scheduler
 * stamps `execution.userId = schedule.createdBy`, and that is the *only* route
 * by which a nightly run knows whose brain it is working on. A schedule created
 * without `createdBy`, or carrying somebody else's id, is not a broken
 * schedule — it is a run against the wrong person's data.
 *
 * The other cluster is what must *not* be in these rows. `AiWorkflowSchedule`
 * is core-owned with `createdBy: onDelete: SetNull`, so the row outlives the
 * account; anything personal stamped into `inputTemplate` outlives it too, as an
 * orphan no erasure can reach. `inputTemplate` is `{ userId }` and the test
 * asserts the *absence* of an address, because the natural implementation —
 * `send_notification` resolving `{{input.userEmail}}` — puts one there.
 *
 * Test Coverage:
 * - Creates one schedule per workflow, with `createdBy` set to the owner
 * - `inputTemplate` carries the userId and no email address
 * - Cron expressions are built in the user's timezone, not the server's
 * - A second call creates nothing — it is safe on every login
 * - A schedule whose cron no longer matches the zone's offset is rewritten
 * - Rewriting does not touch `isEnabled` — an off schedule stays off
 * - A missing workflow row is reported, not thrown
 *
 * @see lib/framework/obsiddy/schedules/ensure.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/obsiddy/repo/schedules', () => ({
  listObsiddySchedules: vi.fn(),
  findObsiddyWorkflowIds: vi.fn(),
  createObsiddySchedule: vi.fn(),
  updateObsiddyScheduleCron: vi.fn(),
}));

import {
  ensureObsiddySchedules,
  OBSIDDY_SCHEDULED_WORKFLOWS,
} from '@/lib/framework/obsiddy/schedules/ensure';
import {
  createObsiddySchedule,
  findObsiddyWorkflowIds,
  listObsiddySchedules,
  updateObsiddyScheduleCron,
} from '@/lib/framework/obsiddy/repo/schedules';
import { dailyCron, monthlyCron, weeklyCron } from '@/lib/framework/obsiddy/schedules/cron';

const mockedList = vi.mocked(listObsiddySchedules);
const mockedWorkflowIds = vi.mocked(findObsiddyWorkflowIds);
const mockedCreate = vi.mocked(createObsiddySchedule);
const mockedUpdate = vi.mocked(updateObsiddyScheduleCron);

const USER = 'user_a';
/** Mutable so a test can switch zone without threading it through every call. */
const TZ = { current: 'UTC' };
const SUMMER = new Date('2026-07-15T12:00:00.000Z');
const WINTER = new Date('2026-01-15T12:00:00.000Z');

const ALL_SLUGS = Object.values(OBSIDDY_SCHEDULED_WORKFLOWS);

function allWorkflowsExist() {
  return new Map(ALL_SLUGS.map((slug, i) => [slug, `wf_${i}`]));
}

beforeEach(() => {
  vi.clearAllMocks();
  TZ.current = 'UTC';
  mockedWorkflowIds.mockResolvedValue(allWorkflowsExist());
  mockedList.mockResolvedValue([]);
  mockedCreate.mockResolvedValue('sched_1');
});

describe('ensureObsiddySchedules — first run', () => {
  it('creates one schedule per workflow', async () => {
    const result = await ensureObsiddySchedules(USER, TZ.current, SUMMER);

    expect(mockedCreate).toHaveBeenCalledTimes(ALL_SLUGS.length);
    expect(result.created.sort()).toEqual([...ALL_SLUGS].sort());
    expect(result.missing).toEqual([]);
  });

  it('sets createdBy to the owner — the only route by which a run knows whose brain it is', async () => {
    await ensureObsiddySchedules(USER, TZ.current, SUMMER);

    for (const call of mockedCreate.mock.calls) {
      expect(call[0].userId).toBe(USER);
    }
  });

  it('never puts an email address in the stored template', async () => {
    await ensureObsiddySchedules(USER, TZ.current, SUMMER);

    for (const call of mockedCreate.mock.calls) {
      const serialised = JSON.stringify(call[0]);
      expect(serialised).not.toMatch(/@/);
      expect(serialised).not.toMatch(/email/i);
    }
  });

  it('builds the cron in the user’s timezone, not the server’s', async () => {
    TZ.current = 'Pacific/Auckland';

    await ensureObsiddySchedules(USER, TZ.current, SUMMER);

    const nightly = mockedCreate.mock.calls.find(
      (call) => call[0].name === 'Obsiddy nightly triage'
    );
    // 03:15 in Auckland (+12 in July) is 15:15 UTC the previous day.
    expect(nightly?.[0].cronExpression).toBe('15 15 * * *');
  });
});

describe('ensureObsiddySchedules — repeat runs', () => {
  it('creates nothing on a second call, so it is safe on every login', async () => {
    mockedList.mockResolvedValue(
      ALL_SLUGS.map((slug, i) => ({
        id: `sched_${i}`,
        workflowSlug: slug,
        cronExpression: expectedCronFor(slug, 'UTC', SUMMER),
        isEnabled: true,
      }))
    );

    const result = await ensureObsiddySchedules(USER, TZ.current, SUMMER);

    expect(mockedCreate).not.toHaveBeenCalled();
    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(result.created).toEqual([]);
    expect(result.corrected).toEqual([]);
  });

  it('rewrites a schedule whose cron no longer matches the zone’s offset', async () => {
    TZ.current = 'Europe/London';
    // Stored in winter (GMT), now running in summer (BST) — the DST drift the
    // cron module documents, corrected on the next visit.
    mockedList.mockResolvedValue(
      ALL_SLUGS.map((slug, i) => ({
        id: `sched_${i}`,
        workflowSlug: slug,
        cronExpression: expectedCronFor(slug, 'Europe/London', WINTER),
        isEnabled: true,
      }))
    );

    const result = await ensureObsiddySchedules(USER, TZ.current, SUMMER);

    expect(mockedCreate).not.toHaveBeenCalled();
    expect(result.corrected.length).toBeGreaterThan(0);
    expect(mockedUpdate).toHaveBeenCalled();
  });

  it('does not re-enable a schedule it rewrites', async () => {
    TZ.current = 'Europe/London';
    mockedList.mockResolvedValue([
      {
        id: 'sched_off',
        workflowSlug: OBSIDDY_SCHEDULED_WORKFLOWS.nightlyTriage,
        cronExpression: 'nonsense that will not match',
        isEnabled: false,
      },
    ]);

    await ensureObsiddySchedules(USER, TZ.current, SUMMER);

    // `updateObsiddyScheduleCron` takes (id, cron, nextRunAt) and nothing else —
    // an operator or user who turned a schedule off has turned it off, and a
    // correction pass is not a reason to turn it back on.
    expect(mockedUpdate).toHaveBeenCalledWith('sched_off', expect.any(String), expect.anything());
    expect(mockedUpdate.mock.calls[0]).toHaveLength(3);
  });
});

describe('ensureObsiddySchedules — missing seeds', () => {
  it('reports a missing workflow rather than throwing — this runs on a first page load', async () => {
    mockedWorkflowIds.mockResolvedValue(new Map());

    const result = await ensureObsiddySchedules(USER, TZ.current, SUMMER);

    expect(result.missing.sort()).toEqual([...ALL_SLUGS].sort());
    expect(result.created).toEqual([]);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('still creates the ones that do exist', async () => {
    mockedWorkflowIds.mockResolvedValue(
      new Map([[OBSIDDY_SCHEDULED_WORKFLOWS.nightlyTriage, 'wf_0']])
    );

    const result = await ensureObsiddySchedules(USER, TZ.current, SUMMER);

    expect(result.created).toEqual([OBSIDDY_SCHEDULED_WORKFLOWS.nightlyTriage]);
    expect(result.missing).toHaveLength(ALL_SLUGS.length - 1);
  });
});

/**
 * Re-derives what the module should produce, so the repeat-run tests assert
 * "unchanged" against the real expression rather than a hardcoded copy that
 * would silently stop matching if a schedule time moved.
 */
function expectedCronFor(slug: string, timeZone: string, at: Date): string {
  // Mirrors SCHEDULE_SPECS. Kept deliberately small: if a schedule time changes,
  // this needs the same edit, and the repeat-run test failing is the reminder.
  switch (slug) {
    case OBSIDDY_SCHEDULED_WORKFLOWS.nightlyTriage:
      return dailyCron({ hour: 3, minute: 15 }, timeZone, at);
    case OBSIDDY_SCHEDULED_WORKFLOWS.morningBriefing:
      return dailyCron({ hour: 4, minute: 30 }, timeZone, at);
    case OBSIDDY_SCHEDULED_WORKFLOWS.weeklyReview:
      return weeklyCron({ hour: 16, minute: 0 }, 5, timeZone, at);
    default:
      return monthlyCron({ hour: 9, minute: 0 }, 1, timeZone, at);
  }
}
