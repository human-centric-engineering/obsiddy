/**
 * Unit Tests: the phase-3 request schemas.
 *
 * These are the boundary where untrusted input stops, so the cases that matter
 * are the rejections rather than the acceptances. Two are load-bearing:
 *
 *   - **Weights must sum to 1.** `base` is a weighted average, and the
 *     `manualBoost` guarantee only holds while it lands in `[0, 1]`. Weights
 *     summing to 1.4 would break it silently, months after the edit.
 *   - **Snooze takes exactly one of preset or until.** Both would mean two
 *     different instants in one request, and resolving one while ignoring the
 *     other snoozes to a date nobody asked for.
 *
 * @see lib/framework/resparkable/validations.ts
 */

import { describe, it, expect } from 'vitest';

import { DEFAULT_PRIORITY_WEIGHTS } from '@/lib/framework/resparkable/settings';
import {
  createLinkSchema,
  documentUploadSchema,
  energyProfileSchema,
  resparkableAdminSettingsResponseSchema,
  resparkableSettingsSchema,
  priorityWeightsSchema,
  reindexSchema,
  retentionPolicySchema,
  searchQuerySchema,
  snoozeSchema,
  updateLinkSchema,
  updateSpaceSchema,
} from '@/lib/framework/resparkable/validations';

describe('priorityWeightsSchema', () => {
  it('accepts the defaults', () => {
    expect(priorityWeightsSchema.safeParse(DEFAULT_PRIORITY_WEIGHTS).success).toBe(true);
  });

  it('accepts a rebalanced set that still sums to 1', () => {
    // Someone who cares less about deadlines and more about goal alignment.
    const rebalanced = { ...DEFAULT_PRIORITY_WEIGHTS, urgency: 0.2, goalAlignment: 0.35 };

    expect(priorityWeightsSchema.safeParse(rebalanced).success).toBe(true);
  });

  it('rejects weights that do not sum to 1', () => {
    // Arrange: this is what would break the boost guarantee.
    const tooMuch = { ...DEFAULT_PRIORITY_WEIGHTS, urgency: 0.5 };

    // Act
    const result = priorityWeightsSchema.safeParse(tooMuch);

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Weights must sum to 1');
  });

  it('rejects a missing factor rather than defaulting it', () => {
    // A silently-defaulted factor is a weight the user did not choose.
    const partial: Record<string, number> = { ...DEFAULT_PRIORITY_WEIGHTS };
    delete partial.staleness;

    expect(priorityWeightsSchema.safeParse(partial).success).toBe(false);
  });

  it('rejects an unknown factor rather than dropping it', () => {
    // `.strict()`: sending `vibes: 0.1` should be a visible 400, because
    // silently ignoring it means the user thinks they configured something.
    expect(priorityWeightsSchema.safeParse({ ...DEFAULT_PRIORITY_WEIGHTS, vibes: 0 }).success).toBe(
      false
    );
  });

  it('rejects a negative weight', () => {
    expect(
      priorityWeightsSchema.safeParse({
        ...DEFAULT_PRIORITY_WEIGHTS,
        urgency: -0.1,
        goalAlignment: 0.35,
      }).success
    ).toBe(false);
  });

  it('tolerates float representation error', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point, and a user's weights will
    // routinely land a few ulps off 1. The epsilon exists for this and nothing
    // else — it must not be wide enough to admit a real mistake.
    const drifted = {
      urgency: 0.1,
      goalAlignment: 0.2,
      projectMomentum: 0.3,
      areaBalance: 0.2,
      effortFit: 0.1,
      staleness: 0.1,
    };

    expect(priorityWeightsSchema.safeParse(drifted).success).toBe(true);
  });
});

describe('energyProfileSchema', () => {
  it('accepts the three bands', () => {
    expect(
      energyProfileSchema.safeParse({ morning: 'high', afternoon: 'medium', evening: 'low' })
        .success
    ).toBe(true);
  });

  it('rejects an unknown level', () => {
    expect(
      energyProfileSchema.safeParse({ morning: 'caffeinated', afternoon: 'medium', evening: 'low' })
        .success
    ).toBe(false);
  });

  it('rejects a missing band', () => {
    expect(energyProfileSchema.safeParse({ morning: 'high', afternoon: 'medium' }).success).toBe(
      false
    );
  });
});

describe('retentionPolicySchema', () => {
  it('rejects a zero window', () => {
    // A zero window would archive everything on the next retention pass.
    const policy = {
      inboxThoughtDays: 0,
      completedTaskDays: 180,
      closedProjectDays: 180,
      reviewDays: 730,
      staleEntityDays: 365,
      suggestedLinkDays: 60,
      eventDays: 400,
      planTimeBlockDays: 90,
    };

    expect(retentionPolicySchema.safeParse(policy).success).toBe(false);
  });

  it('rejects a fractional window', () => {
    const policy = {
      inboxThoughtDays: 90.5,
      completedTaskDays: 180,
      closedProjectDays: 180,
      reviewDays: 730,
      staleEntityDays: 365,
      suggestedLinkDays: 60,
      eventDays: 400,
      planTimeBlockDays: 90,
    };

    expect(retentionPolicySchema.safeParse(policy).success).toBe(false);
  });
});

describe('updateSpaceSchema', () => {
  it('accepts a partial patch', () => {
    expect(updateSpaceSchema.safeParse({ workStyle: 'exploratory' }).success).toBe(true);
  });

  it('accepts an empty patch', () => {
    // A no-op save is harmless and simpler than special-casing it in the route.
    expect(updateSpaceSchema.safeParse({}).success).toBe(true);
  });

  it('accepts null to reset a Json column to its defaults', () => {
    expect(updateSpaceSchema.safeParse({ priorityWeights: null }).success).toBe(true);
  });

  it('accepts a real IANA zone', () => {
    expect(updateSpaceSchema.safeParse({ timezone: 'Pacific/Auckland' }).success).toBe(true);
  });

  it('rejects a zone the runtime does not know', () => {
    // Checked against the runtime's own database rather than a curated list —
    // rejecting a valid zone that a UI picker happens to omit would be wrong.
    const result = updateSpaceSchema.safeParse({ timezone: 'Mars/Olympus_Mons' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Unknown IANA time zone');
  });

  it.each(['+13:00', '-05:00', 'UTC+13', 'GMT-5'])(
    'rejects the fixed offset %s, which Intl would otherwise accept',
    (timezone) => {
      // ECMA-402 treats these as valid zones and they resolve to real instants,
      // so nothing visibly breaks — the user just drifts an hour twice a year
      // on every preset, for six months, before anyone connects the two.
      expect(updateSpaceSchema.safeParse({ timezone }).success).toBe(false);
    }
  );

  it('still accepts the zones that genuinely never shift', () => {
    expect(updateSpaceSchema.safeParse({ timezone: 'UTC' }).success).toBe(true);
    expect(updateSpaceSchema.safeParse({ timezone: 'GMT' }).success).toBe(true);
  });

  it('accepts a legacy zone name with no region prefix', () => {
    // 'Japan' and 'NZ' are IANA links, carry real DST rules, and would be
    // rejected by any rule that demanded a slash.
    expect(updateSpaceSchema.safeParse({ timezone: 'Japan' }).success).toBe(true);
    expect(updateSpaceSchema.safeParse({ timezone: 'NZ' }).success).toBe(true);
  });

  it('rejects the inbox token', () => {
    // It is a bearer credential and rotates through its own endpoint, never as
    // a field in a settings save.
    expect(updateSpaceSchema.safeParse({ inboxToken: 'b'.repeat(32) }).success).toBe(false);
  });

  it('rejects a userId', () => {
    expect(updateSpaceSchema.safeParse({ userId: 'user_b' }).success).toBe(false);
  });

  it('rejects a weekly capacity beyond the hours in a week', () => {
    expect(updateSpaceSchema.safeParse({ weeklyCapacityMinutes: 20_000 }).success).toBe(false);
  });

  it('allows a weekly capacity of zero', () => {
    // A legitimate state — someone on leave, or tracking a personal area only.
    expect(updateSpaceSchema.safeParse({ weeklyCapacityMinutes: 0 }).success).toBe(true);
  });
});

describe('snoozeSchema', () => {
  it.each(['later_today', 'tomorrow', 'next_week', 'next_month'])(
    'accepts the %s preset',
    (preset) => {
      expect(snoozeSchema.safeParse({ preset }).success).toBe(true);
    }
  );

  it('accepts an explicit date', () => {
    expect(snoozeSchema.safeParse({ until: '2026-09-01T00:00:00.000Z' }).success).toBe(true);
  });

  it('coerces a date string to a Date', () => {
    const result = snoozeSchema.safeParse({ until: '2026-09-01T00:00:00.000Z' });

    expect(result.data?.until).toBeInstanceOf(Date);
  });

  it('rejects both a preset and a date', () => {
    const result = snoozeSchema.safeParse({ preset: 'tomorrow', until: '2026-09-01T00:00:00Z' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Provide exactly one of preset or until');
  });

  it('rejects neither', () => {
    expect(snoozeSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an unknown preset rather than falling back to a default', () => {
    // "someday" silently becoming "tomorrow" is worse than an error.
    expect(snoozeSchema.safeParse({ preset: 'someday' }).success).toBe(false);
  });

  it('rejects an unknown field', () => {
    expect(snoozeSchema.safeParse({ preset: 'tomorrow', snoozeCount: 0 }).success).toBe(false);
  });
});

// ─── Phase 4: search, indexing, links, documents, instance settings ─────────

const VALID_SEARCH_QUERY = { q: 'kestrel' };

describe('searchQuerySchema', () => {
  it('accepts a bare query with every other field defaulted', () => {
    const result = searchQuerySchema.safeParse(VALID_SEARCH_QUERY);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ limit: 20, includeArchived: false });
    expect(result.data?.types).toBeUndefined();
  });

  it('rejects an empty query', () => {
    expect(searchQuerySchema.safeParse({ q: '' }).success).toBe(false);
  });

  it('splits a comma-separated types list into an array', () => {
    const result = searchQuerySchema.safeParse({ ...VALID_SEARCH_QUERY, types: 'thought,project' });

    expect(result.success).toBe(true);
    expect(result.data?.types).toEqual(['thought', 'project']);
  });

  it('trims whitespace around each comma-separated type', () => {
    const result = searchQuerySchema.safeParse({
      ...VALID_SEARCH_QUERY,
      types: ' thought , project ',
    });

    expect(result.data?.types).toEqual(['thought', 'project']);
  });

  it('drops empty segments from a trailing comma without erroring', () => {
    const result = searchQuerySchema.safeParse({ ...VALID_SEARCH_QUERY, types: 'thought,' });

    expect(result.success).toBe(true);
    expect(result.data?.types).toEqual(['thought']);
  });

  it('rejects an unknown type rather than silently dropping it', () => {
    // Silently ignoring "documnet" would return "no results" for a typo, which
    // reads as "you have no documents" instead of "you made a typo".
    const result = searchQuerySchema.safeParse({ ...VALID_SEARCH_QUERY, types: 'documnet' });

    expect(result.success).toBe(false);
  });

  it('rejects an unknown type mixed in with valid ones', () => {
    const result = searchQuerySchema.safeParse({
      ...VALID_SEARCH_QUERY,
      types: 'thought,bogus',
    });

    expect(result.success).toBe(false);
  });

  it.each([0, -1, 51])('rejects a limit of %d, outside (0, 50]', (limit) => {
    expect(searchQuerySchema.safeParse({ ...VALID_SEARCH_QUERY, limit }).success).toBe(false);
  });

  it('accepts the limit boundary of 50', () => {
    expect(searchQuerySchema.safeParse({ ...VALID_SEARCH_QUERY, limit: 50 }).success).toBe(true);
  });

  it.each([-0.1, 1.1])('rejects a maxDistance of %d, outside [0, 1]', (maxDistance) => {
    expect(searchQuerySchema.safeParse({ ...VALID_SEARCH_QUERY, maxDistance }).success).toBe(false);
  });

  it('accepts maxDistance at both boundaries', () => {
    expect(searchQuerySchema.safeParse({ ...VALID_SEARCH_QUERY, maxDistance: 0 }).success).toBe(
      true
    );
    expect(searchQuerySchema.safeParse({ ...VALID_SEARCH_QUERY, maxDistance: 1 }).success).toBe(
      true
    );
  });

  it('transforms includeArchived from the string "true" to the boolean true', () => {
    const result = searchQuerySchema.safeParse({ ...VALID_SEARCH_QUERY, includeArchived: 'true' });

    expect(result.data?.includeArchived).toBe(true);
  });

  it('defaults includeArchived to false when omitted', () => {
    const result = searchQuerySchema.safeParse(VALID_SEARCH_QUERY);

    expect(result.data?.includeArchived).toBe(false);
  });

  it('rejects a non-enum includeArchived value rather than coercing it', () => {
    // Zod's boolean coercion would treat any non-empty string as true, silently
    // accepting "yes" or "1". The enum keeps that decision explicit.
    expect(
      searchQuerySchema.safeParse({ ...VALID_SEARCH_QUERY, includeArchived: 'yes' }).success
    ).toBe(false);
  });

  it('rejects an unknown field, including userId', () => {
    expect(searchQuerySchema.safeParse({ ...VALID_SEARCH_QUERY, userId: 'user_b' }).success).toBe(
      false
    );
  });
});

describe('reindexSchema', () => {
  it('accepts an empty body — every field is optional', () => {
    expect(reindexSchema.safeParse({}).success).toBe(true);
  });

  it('defaults force to false', () => {
    const result = reindexSchema.safeParse({});

    expect(result.data?.force).toBe(false);
  });

  it('accepts a restricted list of embedded types', () => {
    const result = reindexSchema.safeParse({ types: ['thought', 'document'] });

    expect(result.success).toBe(true);
  });

  it('rejects "task" as a reindex type — tasks are not embedded', () => {
    expect(reindexSchema.safeParse({ types: ['task'] }).success).toBe(false);
  });

  it('rejects an empty types array rather than treating it as "no filter"', () => {
    expect(reindexSchema.safeParse({ types: [] }).success).toBe(false);
  });

  it.each([0, -1, 501])('rejects a limitPerType of %d, outside (0, 500]', (limitPerType) => {
    expect(reindexSchema.safeParse({ limitPerType }).success).toBe(false);
  });

  it('accepts the limitPerType boundary of 500', () => {
    expect(reindexSchema.safeParse({ limitPerType: 500 }).success).toBe(true);
  });

  it('rejects an unknown field, including userId', () => {
    expect(reindexSchema.safeParse({ userId: 'user_b' }).success).toBe(false);
  });
});

const VALID_LINK = {
  sourceType: 'thought',
  sourceId: 'clx1234567890123456789012',
  targetType: 'project',
  targetId: 'clx1234567890123456789013',
};

describe('createLinkSchema', () => {
  it('accepts a valid cross-type link, defaulting kind to relates_to', () => {
    const result = createLinkSchema.safeParse(VALID_LINK);

    expect(result.success).toBe(true);
    expect(result.data?.kind).toBe('relates_to');
  });

  it('rejects linking an item to itself — same type and same id', () => {
    const result = createLinkSchema.safeParse({
      ...VALID_LINK,
      targetType: VALID_LINK.sourceType,
      targetId: VALID_LINK.sourceId,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('An item cannot be linked to itself');
    expect(result.error?.issues[0]?.path).toEqual(['targetId']);
  });

  it('allows the same id when the types differ — not actually the same item', () => {
    // A thought and a project can coincidentally share no real relationship to
    // an id collision here (ids are per-type in practice), but the refinement
    // only fires when BOTH type and id match — this pins that it is an AND.
    const result = createLinkSchema.safeParse({
      ...VALID_LINK,
      targetType: 'project',
      targetId: VALID_LINK.sourceId,
    });

    expect(result.success).toBe(true);
  });

  it('rejects an invalid cuid for sourceId', () => {
    expect(createLinkSchema.safeParse({ ...VALID_LINK, sourceId: 'not-a-cuid' }).success).toBe(
      false
    );
  });

  it('rejects an unknown link kind', () => {
    expect(createLinkSchema.safeParse({ ...VALID_LINK, kind: 'befriends' }).success).toBe(false);
  });

  it('does NOT accept strength — it is a measured value, not client-supplied', () => {
    // Accepting it would let a caller fabricate a similarity that outranks real
    // measured links.
    expect(createLinkSchema.safeParse({ ...VALID_LINK, strength: 0.99 }).success).toBe(false);
  });

  it('does NOT accept origin — it is set server-side to "user"', () => {
    expect(createLinkSchema.safeParse({ ...VALID_LINK, origin: 'sweep' }).success).toBe(false);
  });

  it('rejects an unknown field, including userId', () => {
    expect(createLinkSchema.safeParse({ ...VALID_LINK, userId: 'user_b' }).success).toBe(false);
  });

  it('accepts a null rationale and an explicit undefined the same as omitting it', () => {
    expect(createLinkSchema.safeParse({ ...VALID_LINK, rationale: null }).success).toBe(true);
  });

  it('rejects a rationale over 2000 characters', () => {
    expect(createLinkSchema.safeParse({ ...VALID_LINK, rationale: 'x'.repeat(2001) }).success).toBe(
      false
    );
  });
});

describe('updateLinkSchema', () => {
  it('accepts an empty patch', () => {
    expect(updateLinkSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a status-only patch — reviewing a suggestion', () => {
    expect(updateLinkSchema.safeParse({ status: 'accepted' }).success).toBe(true);
  });

  it('rejects an unknown status', () => {
    expect(updateLinkSchema.safeParse({ status: 'archived' }).success).toBe(false);
  });

  it('coerces snoozedUntil to a Date', () => {
    const result = updateLinkSchema.safeParse({ snoozedUntil: '2026-09-01T00:00:00.000Z' });

    expect(result.data?.snoozedUntil).toBeInstanceOf(Date);
  });

  it('accepts a null snoozedUntil to clear it', () => {
    expect(updateLinkSchema.safeParse({ snoozedUntil: null }).success).toBe(true);
  });

  it('rejects an unknown field, including userId', () => {
    expect(updateLinkSchema.safeParse({ userId: 'user_b' }).success).toBe(false);
  });

  it('does not accept sourceType/sourceId — a link cannot be re-pointed, only reviewed', () => {
    expect(updateLinkSchema.safeParse({ sourceType: 'thought' }).success).toBe(false);
  });
});

describe('documentUploadSchema', () => {
  it('accepts an empty body — both fields are optional', () => {
    expect(documentUploadSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a title and a valid sourceUrl', () => {
    expect(
      documentUploadSchema.safeParse({ title: 'Q4 Plan', sourceUrl: 'https://example.com/q4.pdf' })
        .success
    ).toBe(true);
  });

  /**
   * REGRESSION. This schema briefly checked the protocol with
   * `.refine((v) => /^https?:$/.test(new URL(v).protocol))`, which looks right and
   * is not: Zod runs every check on a field and collects issues rather than
   * short-circuiting, so the callback still ran on malformed input and
   * `new URL('not-a-url')` threw a raw `TypeError` — out of `safeParse` itself,
   * past `handleAPIError`'s `instanceof z.ZodError` test, turning a 400 into a 500.
   *
   * The fix was to stop hand-rolling it and use Zod's own `protocol` option, which
   * has no callback to get wrong. These cases pin both halves: **never throw**, and
   * still reject the scheme this exists to block.
   */
  // NB: `https:/one-slash` is deliberately NOT in this list — the WHATWG parser
  // normalises it to `https://one-slash/`, so it is a valid https URL and being
  // accepted is correct. Worth recording, because it looks malformed.
  it.each(['not-a-url', '', 'http://', '://no-scheme', 'https://'])(
    'rejects malformed sourceUrl %o without throwing',
    (value) => {
      // The assertion is as much about the ABSENCE of a throw as the result: if
      // this ever throws again, the failure message says so rather than reading as
      // a plain expectation miss.
      expect(() => documentUploadSchema.safeParse({ sourceUrl: value })).not.toThrow();
      expect(documentUploadSchema.safeParse({ sourceUrl: value }).success).toBe(false);
    }
  );

  it.each([
    'javascript:alert(1)',
    'ftp://example.com/f',
    'data:text/html,<script>',
    'file:///etc/passwd',
  ])('rejects the non-http scheme %o — this field will be rendered as a link one day', (value) => {
    expect(documentUploadSchema.safeParse({ sourceUrl: value }).success).toBe(false);
  });

  it('still accepts http as well as https', () => {
    expect(documentUploadSchema.safeParse({ sourceUrl: 'http://example.com/f.pdf' }).success).toBe(
      true
    );
  });

  it('rejects an empty title rather than treating it as omitted', () => {
    expect(documentUploadSchema.safeParse({ title: '' }).success).toBe(false);
  });

  it('rejects a title over 500 characters', () => {
    expect(documentUploadSchema.safeParse({ title: 'x'.repeat(501) }).success).toBe(false);
  });

  it('rejects an unknown field, including userId', () => {
    expect(documentUploadSchema.safeParse({ userId: 'user_b' }).success).toBe(false);
  });
});

describe('resparkableSettingsSchema', () => {
  const ONE_MB = 1024 * 1024;
  const TWO_HUNDRED_MB = 200 * 1024 * 1024;

  it('accepts an empty patch — every field is optional', () => {
    expect(resparkableSettingsSchema.safeParse({}).success).toBe(true);
  });

  it('accepts documentOriginals alone', () => {
    expect(resparkableSettingsSchema.safeParse({ documentOriginals: 'retain' }).success).toBe(true);
  });

  it('rejects an unknown documentOriginals mode', () => {
    expect(resparkableSettingsSchema.safeParse({ documentOriginals: 'archive' }).success).toBe(
      false
    );
  });

  it('rejects a maxDocumentBytes below the 1 MB floor', () => {
    expect(resparkableSettingsSchema.safeParse({ maxDocumentBytes: ONE_MB - 1 }).success).toBe(
      false
    );
  });

  it('accepts the 1 MB floor exactly', () => {
    expect(resparkableSettingsSchema.safeParse({ maxDocumentBytes: ONE_MB }).success).toBe(true);
  });

  it('rejects a maxDocumentBytes above the 200 MB ceiling', () => {
    expect(
      resparkableSettingsSchema.safeParse({ maxDocumentBytes: TWO_HUNDRED_MB + 1 }).success
    ).toBe(false);
  });

  it('accepts the 200 MB ceiling exactly', () => {
    expect(resparkableSettingsSchema.safeParse({ maxDocumentBytes: TWO_HUNDRED_MB }).success).toBe(
      true
    );
  });

  it('accepts null to reset maxDocumentBytes to the code default', () => {
    expect(resparkableSettingsSchema.safeParse({ maxDocumentBytes: null }).success).toBe(true);
  });

  it('rejects a fractional maxDocumentBytes', () => {
    expect(resparkableSettingsSchema.safeParse({ maxDocumentBytes: ONE_MB + 0.5 }).success).toBe(
      false
    );
  });

  it('rejects an unknown field, including userId — this table has no owner', () => {
    expect(resparkableSettingsSchema.safeParse({ userId: 'user_b' }).success).toBe(false);
  });
});

describe('resparkableAdminSettingsResponseSchema', () => {
  const VALID_RESPONSE = {
    documentOriginals: 'discard',
    maxDocumentBytes: 25 * 1024 * 1024,
    isDefault: true,
    storage: { capable: false, provider: null, reason: 'No storage provider configured' },
  };

  it('accepts the well-formed admin response shape', () => {
    expect(resparkableAdminSettingsResponseSchema.safeParse(VALID_RESPONSE).success).toBe(true);
  });

  it('rejects a non-positive maxDocumentBytes', () => {
    expect(
      resparkableAdminSettingsResponseSchema.safeParse({ ...VALID_RESPONSE, maxDocumentBytes: 0 })
        .success
    ).toBe(false);
  });

  it('rejects a missing storage sub-object', () => {
    const { storage: _storage, ...withoutStorage } = VALID_RESPONSE;

    expect(resparkableAdminSettingsResponseSchema.safeParse(withoutStorage).success).toBe(false);
  });

  it('accepts a null storage provider and reason together with capable: false', () => {
    expect(
      resparkableAdminSettingsResponseSchema.safeParse({
        ...VALID_RESPONSE,
        storage: { capable: false, provider: null, reason: null },
      }).success
    ).toBe(true);
  });

  it('rejects an unknown documentOriginals mode from a tampered response', () => {
    expect(
      resparkableAdminSettingsResponseSchema.safeParse({
        ...VALID_RESPONSE,
        documentOriginals: 'shred',
      }).success
    ).toBe(false);
  });
});
