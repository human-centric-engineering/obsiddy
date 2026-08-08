/**
 * Unit tests for lib/portability/import-account.ts.
 *
 * The mirror of `export-account.test.ts`: this file tests the seam's own
 * decisions, not the pieces it joins (bundle reading, planning, and writing
 * each belong to their own modules). What actually lives here worth testing:
 *
 *   1. `planAccountImport` wires the bundle, the account, and an owner-scoped
 *      lookup into the planner — and only that account's lookup, never a
 *      caller-supplied one
 *   2. its return value is what a caller reads (`totalRows`, `ignoredCount`,
 *      `originalsAvailable`) computed from the bundle, not invented
 *   3. `applyAccountImport` re-plans rather than trusting a stashed plan —
 *      documented as the point, not an accident — and strips `originals`
 *      from what it hands back, since a plan response should not carry
 *      somebody's PDFs alongside it
 *   4. caps pass through when the caller (the background worker) supplies
 *      them, and default when it does not
 *   5. a refusal from any of the three ports (`TransferBundleError`,
 *      `TransferLookupError`, `TransferApplyError`) propagates rather than
 *      being swallowed
 *
 * @see lib/portability/import-account.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class MockTransferBundleError extends Error {
    reason: string;
    constructor(message: string, reason: string) {
      super(message);
      this.reason = reason;
      this.name = 'TransferBundleError';
    }
  }

  class MockTransferLookupError extends Error {
    reason: string;
    constructor(message: string, reason: string) {
      super(message);
      this.reason = reason;
      this.name = 'TransferLookupError';
    }
  }

  class MockTransferApplyError extends Error {
    reason: string;
    constructor(message: string, reason: string) {
      super(message);
      this.reason = reason;
      this.name = 'TransferApplyError';
    }
  }

  return {
    readTransferBundle: vi.fn(),
    buildImportPlan: vi.fn(),
    createExistingLookup: vi.fn(),
    applyImportPlan: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    MockTransferBundleError,
    MockTransferLookupError,
    MockTransferApplyError,
  };
});

const { MockTransferBundleError, MockTransferLookupError, MockTransferApplyError } = mocks;

vi.mock('@/lib/logging', () => ({ logger: mocks.logger }));
vi.mock('@/lib/portability/read-bundle', () => ({
  readTransferBundle: mocks.readTransferBundle,
  TransferBundleError: mocks.MockTransferBundleError,
}));
vi.mock('@/lib/portability/import-plan', () => ({
  buildImportPlan: mocks.buildImportPlan,
}));
vi.mock('@/lib/portability/import-lookup', () => ({
  createExistingLookup: mocks.createExistingLookup,
  TransferLookupError: mocks.MockTransferLookupError,
}));
vi.mock('@/lib/portability/apply-import', () => ({
  applyImportPlan: mocks.applyImportPlan,
  TransferApplyError: mocks.MockTransferApplyError,
}));

import { planAccountImport, applyAccountImport } from '@/lib/portability/import-account';

const ARCHIVE = new Uint8Array([80, 75, 3, 4]);

function bundle(overrides: Record<string, unknown> = {}) {
  return {
    totalRows: 10,
    ignoredCount: 0,
    originals: new Map(),
    ...overrides,
  };
}

function plan(overrides: Record<string, unknown> = {}) {
  return {
    source: { subjectUserId: 'source-user' },
    schemaMatches: true,
    groups: ['brain'],
    totals: { rows: 10, creates: 10, matches: 0, softMatches: 0, drops: 0 },
    models: [],
    unknownModels: [],
    notImported: [],
    softMatches: { total: 0, sample: [] },
    orphans: { total: 0, sample: [] },
    canary: { total: 0, sample: [] },
    contested: [],
    warnings: [],
    order: [],
    resolved: new Map(),
    ...overrides,
  };
}

const LOOKUP_SENTINEL = { kind: 'existing-lookup' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readTransferBundle.mockReturnValue(bundle());
  mocks.buildImportPlan.mockResolvedValue(plan());
  mocks.createExistingLookup.mockReturnValue(LOOKUP_SENTINEL);
  mocks.applyImportPlan.mockResolvedValue({
    models: [],
    totals: { created: 10, overwritten: 0, skipped: 0, dropped: 0, linked: 0 },
    secondPass: [],
    originals: { stored: 0, skipped: 0, bytes: 0 },
    warnings: [],
  });
});

describe('planAccountImport', () => {
  it('reads the bundle and builds an owner-scoped lookup for exactly the calling account', async () => {
    await planAccountImport({ userId: 'user-1', archive: ARCHIVE });

    expect(mocks.readTransferBundle).toHaveBeenCalledWith(ARCHIVE);
    expect(mocks.createExistingLookup).toHaveBeenCalledWith('user-1');
  });

  it('plans against this account as the target, whatever account the bundle came from', async () => {
    mocks.readTransferBundle.mockReturnValue(bundle());

    await planAccountImport({ userId: 'importing-user', archive: ARCHIVE });

    expect(mocks.buildImportPlan).toHaveBeenCalledWith({
      bundle: bundle(),
      targetUserId: 'importing-user',
      lookup: LOOKUP_SENTINEL,
    });
  });

  it('reports totals computed from the bundle, not invented', async () => {
    mocks.readTransferBundle.mockReturnValue(
      bundle({
        totalRows: 250,
        ignoredCount: 3,
        originals: new Map([
          ['a', {}],
          ['b', {}],
        ]),
      })
    );

    const result = await planAccountImport({ userId: 'user-1', archive: ARCHIVE });

    expect(result.totalRows).toBe(250);
    expect(result.ignoredCount).toBe(3);
    expect(result.originalsAvailable).toBe(2);
  });

  it('carries the built plan through unchanged', async () => {
    const builtPlan = plan({
      totals: { rows: 99, creates: 99, matches: 0, softMatches: 0, drops: 0 },
    });
    mocks.buildImportPlan.mockResolvedValue(builtPlan);

    const result = await planAccountImport({ userId: 'user-1', archive: ARCHIVE });

    expect(result.plan).toBe(builtPlan);
  });

  it('logs a summary naming the source account without letting it decide anything', async () => {
    mocks.buildImportPlan.mockResolvedValue(
      plan({ source: { subjectUserId: 'someone-elses-id' } })
    );

    await planAccountImport({ userId: 'user-1', archive: ARCHIVE });

    expect(mocks.logger.info).toHaveBeenCalledWith(
      'Account import planned',
      expect.objectContaining({ userId: 'user-1', sourceUserId: 'someone-elses-id' })
    );
  });

  it('propagates a TransferBundleError from an unreadable archive', async () => {
    mocks.readTransferBundle.mockImplementation(() => {
      throw new MockTransferBundleError('not a zip', 'not-an-archive');
    });

    await expect(planAccountImport({ userId: 'user-1', archive: ARCHIVE })).rejects.toMatchObject({
      name: 'TransferBundleError',
      reason: 'not-an-archive',
    });
    expect(mocks.buildImportPlan).not.toHaveBeenCalled();
  });

  it('propagates a TransferLookupError raised while planning', async () => {
    mocks.buildImportPlan.mockRejectedValue(
      new MockTransferLookupError('too many candidates', 'soft-key-cap')
    );

    await expect(planAccountImport({ userId: 'user-1', archive: ARCHIVE })).rejects.toMatchObject({
      name: 'TransferLookupError',
      reason: 'soft-key-cap',
    });
  });
});

describe('applyAccountImport', () => {
  it('re-plans rather than trusting a stashed plan — buildImportPlan runs on apply too', async () => {
    await applyAccountImport({ userId: 'user-1', archive: ARCHIVE, conflictMode: 'skip' });

    expect(mocks.readTransferBundle).toHaveBeenCalledWith(ARCHIVE);
    expect(mocks.buildImportPlan).toHaveBeenCalledTimes(1);
  });

  it('writes the freshly built plan under the requested conflict mode', async () => {
    const builtPlan = plan();
    mocks.buildImportPlan.mockResolvedValue(builtPlan);

    await applyAccountImport({ userId: 'user-1', archive: ARCHIVE, conflictMode: 'overwrite' });

    expect(mocks.applyImportPlan).toHaveBeenCalledWith(
      expect.objectContaining({ plan: builtPlan, userId: 'user-1', conflictMode: 'overwrite' })
    );
  });

  it('passes the bundle’s originals through to the applier', async () => {
    const originals = new Map([['row-1', { model: 'ResparkableDocument' }]]);
    mocks.readTransferBundle.mockReturnValue(bundle({ originals }));

    await applyAccountImport({ userId: 'user-1', archive: ARCHIVE, conflictMode: 'skip' });

    expect(mocks.applyImportPlan).toHaveBeenCalledWith(expect.objectContaining({ originals }));
  });

  it('defaults caps to undefined for the interactive route', async () => {
    await applyAccountImport({ userId: 'user-1', archive: ARCHIVE, conflictMode: 'skip' });

    expect(mocks.applyImportPlan).toHaveBeenCalledWith(
      expect.objectContaining({ caps: undefined })
    );
  });

  it('passes background caps through when the worker supplies them', async () => {
    const caps = { maxRows: 500_000, batchSize: 1_000, timeoutMs: 600_000, maxWaitMs: 60_000 };

    await applyAccountImport({ userId: 'user-1', archive: ARCHIVE, conflictMode: 'skip', caps });

    expect(mocks.applyImportPlan).toHaveBeenCalledWith(expect.objectContaining({ caps }));
  });

  it('strips originals from the returned outcome — a caller should not get PDFs back', async () => {
    const originals = new Map([['row-1', { model: 'ResparkableDocument' }]]);
    mocks.readTransferBundle.mockReturnValue(bundle({ originals }));

    const outcome = await applyAccountImport({
      userId: 'user-1',
      archive: ARCHIVE,
      conflictMode: 'skip',
    });

    expect(outcome).not.toHaveProperty('originals');
  });

  it('returns the plan and the applied result together, so they can be compared', async () => {
    const builtPlan = plan();
    mocks.buildImportPlan.mockResolvedValue(builtPlan);
    const applied = {
      models: [],
      totals: { created: 7, overwritten: 1, skipped: 2, dropped: 0, linked: 0 },
      secondPass: [],
      originals: { stored: 1, skipped: 0, bytes: 512 },
      warnings: [],
    };
    mocks.applyImportPlan.mockResolvedValue(applied);

    const outcome = await applyAccountImport({
      userId: 'user-1',
      archive: ARCHIVE,
      conflictMode: 'skip',
    });

    expect(outcome.plan).toBe(builtPlan);
    expect(outcome.applied).toBe(applied);
  });

  it('logs what was actually written, including originals stored', async () => {
    mocks.applyImportPlan.mockResolvedValue({
      models: [],
      totals: { created: 4, overwritten: 0, skipped: 1, dropped: 2, linked: 0 },
      secondPass: [],
      originals: { stored: 3, skipped: 0, bytes: 999 },
      warnings: [],
    });

    await applyAccountImport({ userId: 'user-1', archive: ARCHIVE, conflictMode: 'overwrite' });

    expect(mocks.logger.info).toHaveBeenCalledWith(
      'Account import written',
      expect.objectContaining({
        userId: 'user-1',
        conflictMode: 'overwrite',
        created: 4,
        skipped: 1,
        dropped: 2,
        originalsStored: 3,
      })
    );
  });

  it('propagates a TransferApplyError from a plan too large for one transaction', async () => {
    mocks.applyImportPlan.mockRejectedValue(new MockTransferApplyError('too many rows', 'row-cap'));

    await expect(
      applyAccountImport({ userId: 'user-1', archive: ARCHIVE, conflictMode: 'skip' })
    ).rejects.toMatchObject({ name: 'TransferApplyError', reason: 'row-cap' });
  });
});
