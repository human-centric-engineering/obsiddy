/**
 * Unit Tests: Obsiddy UI wire-shape schemas.
 *
 * `payloads.ts`'s header documents two deliberate design decisions this file
 * exists to lock in, not merely describe:
 *
 * 1. The schemas are **not** `.strict()` — an unknown key from a newer API
 *    (mid rolling-deploy) must be dropped silently, never thrown on.
 * 2. Dates stay strings on the wire — `isoDate` is `z.string()`, never
 *    `z.coerce.date()` or similar. A real `Date` instance must be REJECTED
 *    (it is not a string), and a valid ISO string must survive parsing as a
 *    string, not get promoted to a `Date`.
 *
 * Every `it` below feeds a real-shaped payload through `safeParse` and
 * asserts on the parse result — never on the existence of a schema.
 *
 * @see lib/framework/obsiddy/ui/payloads.ts
 */

import { describe, expect, it } from 'vitest';

import {
  areaSchema,
  boardCardSchema,
  boardColumnSchema,
  boardSchema,
  boardViewSchema,
  checklistItemSchema,
  connectionRowSchema,
  connectionRowsSchema,
  documentSchema,
  entitySchema,
  entityViewSchema,
  goalSchema,
  graphPayloadSchema,
  inboxPayloadSchema,
  linkEndpointSchema,
  linkSchema,
  projectSchema,
  projectViewSchema,
  relatedItemSchema,
  searchHitSchema,
  searchHitsSchema,
  tagSchema,
  taskSchema,
  taskViewSchema,
  thoughtSchema,
  timeBlockSchema,
  todayPayloadSchema,
  todayTaskSchema,
} from '@/lib/framework/obsiddy/ui/payloads';

const ISO = '2026-01-15T10:30:00.000Z';

// ─── Fixtures ───────────────────────────────────────────────────────────────
// Minimal, schema-shaped builders so each test only overrides what it cares
// about. These mirror the wire shape (strings, not Dates) deliberately.

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    title: 'Write the report',
    notes: null,
    projectId: null,
    status: 'open',
    dueAt: ISO,
    deferUntil: null,
    estimateMinutes: 30,
    energy: 'low',
    contextTag: null,
    priorityScore: 1.5,
    priorityFactors: { dueSoon: true },
    manualBoost: 0,
    manualBoostExpiresAt: null,
    manualBoostReason: null,
    snoozeCount: 0,
    completedAt: null,
    archivedAt: null,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    name: 'Obsiddy',
    slug: 'obsiddy',
    description: null,
    status: 'active',
    areaId: null,
    priorityScore: 2,
    lastActivityAt: ISO,
    closedAt: null,
    snoozedUntil: null,
    archivedAt: null,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

function makeArea(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    name: 'Work',
    slug: 'work',
    description: null,
    colour: '#ff0000',
    sortOrder: 1,
    targetWeeklyMinutes: 300,
    archivedAt: null,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

function makeEntity(overrides: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    name: 'Acme Corp',
    slug: 'acme-corp',
    kind: 'organisation',
    description: null,
    website: null,
    status: 'active',
    lastActivityAt: ISO,
    snoozedUntil: null,
    archivedAt: null,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

function makeLinkEndpoint(overrides: Record<string, unknown> = {}) {
  return {
    type: 'task',
    id: 't1',
    title: 'Write the report',
    subtitle: null,
    archivedAt: null,
    ...overrides,
  };
}

function makeRelatedItem(overrides: Record<string, unknown> = {}) {
  return {
    linkId: 'l1',
    kind: 'reference',
    status: 'active',
    origin: 'manual',
    strength: null,
    rationale: null,
    direction: 'outgoing',
    endpoint: makeLinkEndpoint(),
    ...overrides,
  };
}

function makeTodayTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    title: 'Write the report',
    status: 'open',
    dueAt: ISO,
    estimateMinutes: 30,
    energy: 'low',
    priorityScore: 1.5,
    priorityFactors: {},
    manualBoost: 0,
    manualBoostExpiresAt: null,
    snoozeCount: 0,
    project: null,
    area: null,
    ...overrides,
  };
}

function makeTimeBlock(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tb1',
    title: 'Focus block',
    taskId: 't1',
    projectId: null,
    areaId: null,
    startAt: ISO,
    endAt: ISO,
    source: 'manual',
    notes: null,
    ...overrides,
  };
}

function makeLink(overrides: Record<string, unknown> = {}) {
  return {
    id: 'l1',
    sourceType: 'task',
    sourceId: 't1',
    targetType: 'entity',
    targetId: 'e1',
    kind: 'reference',
    strength: null,
    rationale: null,
    origin: 'manual',
    status: 'pending',
    snoozedUntil: null,
    reviewedAt: null,
    ...overrides,
  };
}

function makeThought(overrides: Record<string, unknown> = {}) {
  return {
    id: 'th1',
    content: 'Call the plumber',
    source: 'inbox',
    status: 'unprocessed',
    promotedToType: null,
    promotedToId: null,
    snoozedUntil: null,
    snoozeCount: 0,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

function makeSearchHit(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1',
    entityType: 'task',
    title: 'Write the report',
    subtitle: null,
    archivedAt: null,
    updatedAt: ISO,
    score: 0.92,
    matchedBy: 'title',
    snippet: null,
    ...overrides,
  };
}

function makeDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: 'd1',
    title: 'Notes.pdf',
    fileName: 'notes.pdf',
    fileHash: 'abc123',
    mimeType: 'application/pdf',
    byteSize: 1024,
    status: 'processed',
    chunkCount: 4,
    sourceUrl: null,
    errorMessage: null,
    archivedAt: null,
    hasOriginal: true,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

function makeGoal(overrides: Record<string, unknown> = {}) {
  return {
    id: 'g1',
    title: 'Ship the UI',
    description: null,
    horizon: 'quarter',
    parentGoalId: null,
    areaId: null,
    targetDate: ISO,
    status: 'active',
    lastActivityAt: ISO,
    archivedAt: null,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

function makeTag(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tag1',
    name: 'urgent',
    slug: 'urgent',
    colour: '#ff0000',
    sortOrder: 1,
    ...overrides,
  };
}

function makeChecklistItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ci1',
    taskId: 't1',
    text: 'Draft outline',
    isDone: false,
    position: 1,
    completedAt: null,
    ...overrides,
  };
}

function makeBoardCard(overrides: Record<string, unknown> = {}) {
  return {
    task: makeTask(),
    tags: [makeTag()],
    checklist: { done: 1, total: 2, items: [makeChecklistItem()] },
    untouchedForMs: 60_000,
    inColumnSinceMs: 30_000,
    position: 1,
    cardId: 'c1',
    ...overrides,
  };
}

function makeBoard(overrides: Record<string, unknown> = {}) {
  return {
    id: 'b1',
    name: 'Sprint board',
    slug: 'sprint-board',
    description: null,
    columns: [{ status: 'open', label: 'Open' }],
    membership: 'manual',
    filter: null,
    swimlaneBy: null,
    archivedAt: null,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

// ─── Design decision #2: dates stay strings ────────────────────────────────

describe('dates stay strings on the wire', () => {
  it('accepts a valid ISO date string and keeps it a string', () => {
    const result = taskSchema.safeParse(makeTask({ dueAt: ISO }));

    expect(result.success).toBe(true);
    if (result.success) {
      expect(typeof result.data.dueAt).toBe('string');
      expect(result.data.dueAt).toBe(ISO);
      expect(result.data.dueAt).not.toBeInstanceOf(Date);
    }
  });

  it('rejects a real Date instance in place of an ISO string', () => {
    // Proves the schema does not coerce — a Date is not a string, so it must
    // fail rather than being silently accepted or converted.
    const result = taskSchema.safeParse(makeTask({ dueAt: new Date(ISO) }));

    expect(result.success).toBe(false);
  });

  it('rejects a Date instance on a required (non-nullable) date field', () => {
    const result = taskSchema.safeParse(makeTask({ createdAt: new Date(ISO) }));

    expect(result.success).toBe(false);
  });

  it('parses createdAt/updatedAt on connectionRowSchema as plain strings', () => {
    const row = {
      id: 'cr1',
      kind: 'reference',
      status: 'active',
      origin: 'manual',
      strength: null,
      rationale: null,
      createdAt: ISO,
      reviewedAt: null,
      source: makeLinkEndpoint(),
      target: makeLinkEndpoint({ id: 'e1', type: 'entity' }),
    };

    const result = connectionRowSchema.safeParse(row);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(typeof result.data.createdAt).toBe('string');
      expect(result.data.createdAt).not.toBeInstanceOf(Date);
    }
  });
});

// ─── Design decision #1: unknown keys are dropped, never thrown on ─────────

describe('unknown keys are stripped without throwing (not .strict())', () => {
  it('drops an unknown top-level key on a flat schema (projectSchema)', () => {
    const result = projectSchema.safeParse({
      ...makeProject(),
      futureFieldFromNewerApi: 'surprise',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('futureFieldFromNewerApi');
      expect(Object.keys(result.data)).not.toContain('futureFieldFromNewerApi');
    }
  });

  it('drops an unknown key inside a nested object (todayTaskSchema.project)', () => {
    const result = todayTaskSchema.safeParse(
      makeTodayTask({
        project: {
          id: 'p1',
          name: 'Obsiddy',
          slug: 'obsiddy',
          status: 'active',
          aBrandNewColumn: 42,
        },
      })
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.project).not.toBeNull();
      expect(result.data.project).not.toHaveProperty('aBrandNewColumn');
    }
  });

  it('drops an unknown key on every array item, not just the first (searchHitsSchema)', () => {
    const result = searchHitsSchema.safeParse([
      makeSearchHit({ id: 's1', newField: 'a' }),
      makeSearchHit({ id: 's2', newField: 'b' }),
    ]);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.every((hit) => !('newField' in hit))).toBe(true);
    }
  });

  it('drops an unknown key several levels deep (boardViewSchema.columns[].cards[].task)', () => {
    const view = {
      board: makeBoard(),
      columns: [
        {
          status: 'open',
          label: 'Open',
          wipLimit: null,
          overWip: false,
          cards: [
            makeBoardCard({
              task: { ...makeTask(), extractedFutureField: 'ignore-me' },
            }),
          ],
        },
      ],
      unplaced: [],
      totalCards: 1,
    };

    const result = boardViewSchema.safeParse(view);

    expect(result.success).toBe(true);
    if (result.success) {
      const parsedTask = result.data.columns[0]?.cards[0]?.task;
      expect(parsedTask).not.toHaveProperty('extractedFutureField');
    }
  });

  it('does not throw — an unrecognised key never surfaces as an exception', () => {
    // safeParse must be used (never .parse()), and a stray key must not be
    // what tips a well-formed payload into failure.
    expect(() => areaSchema.safeParse({ ...makeArea(), rollingDeployField: true })).not.toThrow();
    expect(areaSchema.safeParse({ ...makeArea(), rollingDeployField: true }).success).toBe(true);
  });
});

// ─── /obsiddy/today ─────────────────────────────────────────────────────────

describe('todayTaskSchema', () => {
  it('parses a realistic today-task row', () => {
    const result = todayTaskSchema.safeParse(makeTodayTask());
    expect(result.success).toBe(true);
  });

  it('accepts a populated project and area', () => {
    const result = todayTaskSchema.safeParse(
      makeTodayTask({
        project: { id: 'p1', name: 'Obsiddy', slug: 'obsiddy', status: 'active' },
        area: { id: 'a1', name: 'Work', colour: '#fff' },
      })
    );
    expect(result.success).toBe(true);
  });

  it('rejects a wrong type on a required field', () => {
    const result = todayTaskSchema.safeParse(makeTodayTask({ priorityScore: 'high' }));
    expect(result.success).toBe(false);
  });

  it('accepts any JSON shape for priorityFactors (unknown, incl. arrays/null)', () => {
    expect(todayTaskSchema.safeParse(makeTodayTask({ priorityFactors: [1, 2] })).success).toBe(
      true
    );
    expect(todayTaskSchema.safeParse(makeTodayTask({ priorityFactors: null })).success).toBe(true);
  });
});

describe('timeBlockSchema', () => {
  it('parses a realistic time block', () => {
    expect(timeBlockSchema.safeParse(makeTimeBlock()).success).toBe(true);
  });

  it('rejects a missing required field (startAt)', () => {
    const { startAt: _startAt, ...withoutStartAt } = makeTimeBlock();
    expect(timeBlockSchema.safeParse(withoutStartAt).success).toBe(false);
  });
});

describe('linkSchema', () => {
  it('parses a realistic link row', () => {
    expect(linkSchema.safeParse(makeLink()).success).toBe(true);
  });

  it('rejects a non-string kind', () => {
    expect(linkSchema.safeParse(makeLink({ kind: 7 })).success).toBe(false);
  });
});

describe('todayPayloadSchema', () => {
  function makeTodayPayload(overrides: Record<string, unknown> = {}) {
    return {
      generatedAt: ISO,
      timezone: 'America/Chicago',
      tasks: [makeTodayTask()],
      returnedFromSnooze: ['t2'],
      timeBlocks: [makeTimeBlock()],
      inboxCount: 3,
      openTaskCount: 5,
      goalsAtRisk: [
        { id: 'g1', title: 'Ship it', horizon: 'quarter', targetDate: ISO, status: 'active' },
      ],
      unreviewedLinks: { count: 1, items: [makeLink()] },
      latestReview: { id: 'r1', horizon: 'week', title: 'Weekly review', generatedAt: ISO },
      briefing: {
        review: {
          id: 'b1',
          title: 'Tuesday',
          body: 'You finished three things.',
          generatedAt: ISO,
        },
        stale: false,
        ageHours: 6,
      },
      capacity: {
        weeklyCapacityMinutes: 600,
        plannedMinutesThisWeek: 200,
        remainingMinutes: 400,
      },
      ...overrides,
    };
  }

  it('parses a full realistic /today payload', () => {
    const result = todayPayloadSchema.safeParse(makeTodayPayload());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tasks).toHaveLength(1);
      expect(result.data.capacity.remainingMinutes).toBe(400);
    }
  });

  it('accepts a null latestReview', () => {
    const result = todayPayloadSchema.safeParse(makeTodayPayload({ latestReview: null }));
    expect(result.success).toBe(true);
  });

  it('rejects a malformed nested task inside tasks[]', () => {
    const result = todayPayloadSchema.safeParse(
      makeTodayPayload({ tasks: [makeTodayTask({ id: 42 })] })
    );
    expect(result.success).toBe(false);
  });

  it('rejects a missing capacity object', () => {
    const { capacity: _capacity, ...withoutCapacity } = makeTodayPayload();
    expect(todayPayloadSchema.safeParse(withoutCapacity).success).toBe(false);
  });

  it('drops an unknown top-level key rather than failing the whole payload', () => {
    const result = todayPayloadSchema.safeParse({
      ...makeTodayPayload(),
      nextWeeksFieldFromServer: 'ignore',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('nextWeeksFieldFromServer');
    }
  });
});

// ─── /obsiddy/inbox ─────────────────────────────────────────────────────────

describe('thoughtSchema', () => {
  it('parses a realistic thought row', () => {
    expect(thoughtSchema.safeParse(makeThought()).success).toBe(true);
  });

  it('keeps createdAt/updatedAt as strings', () => {
    const result = thoughtSchema.safeParse(makeThought());
    if (result.success) {
      expect(typeof result.data.createdAt).toBe('string');
      expect(typeof result.data.updatedAt).toBe('string');
    }
  });

  it('rejects an invalid status type', () => {
    expect(thoughtSchema.safeParse(makeThought({ status: null })).success).toBe(false);
  });
});

describe('inboxPayloadSchema', () => {
  function makeInboxPayload(overrides: Record<string, unknown> = {}) {
    return {
      generatedAt: ISO,
      total: 1,
      items: [
        {
          thought: makeThought(),
          suggestedLinks: [
            {
              id: 'sl1',
              targetType: 'project',
              targetId: 'p1',
              kind: 'reference',
              strength: 0.8,
              rationale: null,
              targetLabel: 'Obsiddy',
            },
          ],
          suggestedProjectId: 'p1',
        },
      ],
      ...overrides,
    };
  }

  it('parses a full realistic /inbox payload', () => {
    expect(inboxPayloadSchema.safeParse(makeInboxPayload()).success).toBe(true);
  });

  it('accepts an item with no suggestions', () => {
    const result = inboxPayloadSchema.safeParse(
      makeInboxPayload({
        items: [{ thought: makeThought(), suggestedLinks: [], suggestedProjectId: null }],
      })
    );
    expect(result.success).toBe(true);
  });

  it('rejects a malformed nested thought', () => {
    const result = inboxPayloadSchema.safeParse(
      makeInboxPayload({
        items: [{ thought: { id: 'th1' }, suggestedLinks: [], suggestedProjectId: null }],
      })
    );
    expect(result.success).toBe(false);
  });
});

// ─── /obsiddy/search ────────────────────────────────────────────────────────

describe('searchHitSchema / searchHitsSchema', () => {
  it('parses a realistic search hit', () => {
    expect(searchHitSchema.safeParse(makeSearchHit()).success).toBe(true);
  });

  it('parses an array of hits, count carried separately (meta, not on the schema)', () => {
    const result = searchHitsSchema.safeParse([
      makeSearchHit({ id: 's1' }),
      makeSearchHit({ id: 's2' }),
    ]);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toHaveLength(2);
  });

  it('fails the whole array when one item is malformed (fail-fast, not partial)', () => {
    const result = searchHitsSchema.safeParse([makeSearchHit(), { id: 'bad' }]);
    expect(result.success).toBe(false);
  });

  it('keeps updatedAt as a string, not a Date', () => {
    const result = searchHitSchema.safeParse(makeSearchHit());
    if (result.success) {
      expect(typeof result.data.updatedAt).toBe('string');
    }
  });
});

// ─── Collection rows ────────────────────────────────────────────────────────

describe.each([
  ['projectSchema', projectSchema, makeProject],
  ['goalSchema', goalSchema, makeGoal],
  ['areaSchema', areaSchema, makeArea],
  ['entitySchema', entitySchema, makeEntity],
  ['documentSchema', documentSchema, makeDocument],
  ['taskSchema', taskSchema, makeTask],
] as const)('%s', (_name, schema, factory) => {
  it('parses a realistic row', () => {
    expect(schema.safeParse(factory()).success).toBe(true);
  });

  it('rejects a wrong type on the id field', () => {
    expect(schema.safeParse(factory({ id: 12345 })).success).toBe(false);
  });

  it('drops an unrecognised extra key without throwing', () => {
    const result = schema.safeParse(factory({ someNewColumn: 'x' }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('someNewColumn');
    }
  });
});

describe('documentSchema', () => {
  it('does not require extractedText or storageKey (stripped by the list endpoint)', () => {
    const doc = makeDocument();
    expect('extractedText' in doc).toBe(false);
    expect('storageKey' in doc).toBe(false);
    expect(documentSchema.safeParse(doc).success).toBe(true);
  });

  it('carries hasOriginal as a boolean in their place', () => {
    const result = documentSchema.safeParse(makeDocument({ hasOriginal: false }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.hasOriginal).toBe(false);
  });
});

// ─── Detail views ───────────────────────────────────────────────────────────

describe('linkEndpointSchema', () => {
  it('parses an endpoint whose target still exists', () => {
    expect(linkEndpointSchema.safeParse(makeLinkEndpoint()).success).toBe(true);
  });

  it('accepts a null title (D2: the target row no longer exists)', () => {
    const result = linkEndpointSchema.safeParse(makeLinkEndpoint({ title: null }));
    expect(result.success).toBe(true);
  });
});

describe('relatedItemSchema', () => {
  it('accepts direction "outgoing"', () => {
    expect(relatedItemSchema.safeParse(makeRelatedItem({ direction: 'outgoing' })).success).toBe(
      true
    );
  });

  it('accepts direction "incoming"', () => {
    expect(relatedItemSchema.safeParse(makeRelatedItem({ direction: 'incoming' })).success).toBe(
      true
    );
  });

  it('rejects a direction outside the enum', () => {
    const result = relatedItemSchema.safeParse(makeRelatedItem({ direction: 'lateral' }));
    expect(result.success).toBe(false);
  });
});

describe('projectViewSchema', () => {
  it('parses a full project view with tasks and related items', () => {
    const result = projectViewSchema.safeParse({
      project: makeProject(),
      area: makeArea(),
      tasks: [makeTask()],
      openTaskCount: 1,
      totalTaskCount: 1,
      related: [makeRelatedItem()],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a null area', () => {
    const result = projectViewSchema.safeParse({
      project: makeProject(),
      area: null,
      tasks: [],
      openTaskCount: 0,
      totalTaskCount: 0,
      related: [],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a malformed nested project', () => {
    const result = projectViewSchema.safeParse({
      project: { id: 'p1' },
      area: null,
      tasks: [],
      openTaskCount: 0,
      totalTaskCount: 0,
      related: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('entityViewSchema', () => {
  it('parses a full entity view', () => {
    const result = entityViewSchema.safeParse({
      entity: makeEntity(),
      related: [makeRelatedItem()],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing entity', () => {
    const result = entityViewSchema.safeParse({ related: [] });
    expect(result.success).toBe(false);
  });
});

describe('taskViewSchema', () => {
  it('parses a full task view with project, area and goalTitle', () => {
    const result = taskViewSchema.safeParse({
      task: makeTask(),
      project: makeProject(),
      area: makeArea(),
      goalTitle: 'Ship the UI',
      related: [makeRelatedItem()],
    });
    expect(result.success).toBe(true);
  });

  it('accepts null project, area and goalTitle', () => {
    const result = taskViewSchema.safeParse({
      task: makeTask(),
      project: null,
      area: null,
      goalTitle: null,
      related: [],
    });
    expect(result.success).toBe(true);
  });
});

// ─── /obsiddy/connections ───────────────────────────────────────────────────

describe('connectionRowSchema / connectionRowsSchema', () => {
  function makeConnectionRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'cr1',
      kind: 'reference',
      status: 'active',
      origin: 'manual',
      strength: 0.5,
      rationale: null,
      createdAt: ISO,
      reviewedAt: null,
      source: makeLinkEndpoint(),
      target: makeLinkEndpoint({ id: 'e1', type: 'entity' }),
      ...overrides,
    };
  }

  it('parses a realistic connection row', () => {
    expect(connectionRowSchema.safeParse(makeConnectionRow()).success).toBe(true);
  });

  it('parses an array of connection rows', () => {
    const result = connectionRowsSchema.safeParse([
      makeConnectionRow(),
      makeConnectionRow({ id: 'cr2' }),
    ]);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toHaveLength(2);
  });

  it('drops an unknown key on the row without throwing', () => {
    const result = connectionRowSchema.safeParse(makeConnectionRow({ newField: 'x' }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).not.toHaveProperty('newField');
  });
});

// ─── /obsiddy/graph ─────────────────────────────────────────────────────────

describe('graphPayloadSchema', () => {
  function makeGraphPayload(overrides: Record<string, unknown> = {}) {
    return {
      focus: { type: 'task', id: 't1' },
      nodes: [{ type: 'task', id: 't1', title: 'Write the report', subtitle: null, depth: 0 }],
      edges: [
        {
          linkId: 'l1',
          sourceType: 'task',
          sourceId: 't1',
          targetType: 'entity',
          targetId: 'e1',
          kind: 'reference',
          status: 'active',
          strength: null,
          rationale: null,
        },
      ],
      truncated: false,
      nodeCap: 50,
      depth: 2,
      ...overrides,
    };
  }

  it('parses a realistic graph payload', () => {
    expect(graphPayloadSchema.safeParse(makeGraphPayload()).success).toBe(true);
  });

  it('accepts truncated: true when the node cap was hit', () => {
    const result = graphPayloadSchema.safeParse(makeGraphPayload({ truncated: true }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.truncated).toBe(true);
  });

  it('rejects a malformed edge', () => {
    const result = graphPayloadSchema.safeParse(makeGraphPayload({ edges: [{ linkId: 'l1' }] }));
    expect(result.success).toBe(false);
  });

  it('rejects a non-boolean truncated flag', () => {
    const result = graphPayloadSchema.safeParse(makeGraphPayload({ truncated: 'yes' }));
    expect(result.success).toBe(false);
  });
});

// ─── /obsiddy/boards/[id]/view ──────────────────────────────────────────────

describe('boardSchema', () => {
  it('parses a realistic board row', () => {
    expect(boardSchema.safeParse(makeBoard()).success).toBe(true);
  });

  it('accepts any JSON shape for columns/filter (unknown)', () => {
    const result = boardSchema.safeParse(
      makeBoard({ columns: { grouped: true }, filter: { status: ['open'] } })
    );
    expect(result.success).toBe(true);
  });
});

describe('tagSchema', () => {
  it('parses a realistic tag', () => {
    expect(tagSchema.safeParse(makeTag()).success).toBe(true);
  });

  it('rejects a missing colour', () => {
    const { colour: _colour, ...withoutColour } = makeTag();
    expect(tagSchema.safeParse(withoutColour).success).toBe(false);
  });
});

describe('checklistItemSchema', () => {
  it('parses a realistic checklist item', () => {
    expect(checklistItemSchema.safeParse(makeChecklistItem()).success).toBe(true);
  });

  it('keeps completedAt a string when present, and accepts null', () => {
    const withDate = checklistItemSchema.safeParse(makeChecklistItem({ completedAt: ISO }));
    expect(withDate.success).toBe(true);
    if (withDate.success) expect(typeof withDate.data.completedAt).toBe('string');

    const withNull = checklistItemSchema.safeParse(makeChecklistItem({ completedAt: null }));
    expect(withNull.success).toBe(true);
  });
});

describe('boardCardSchema', () => {
  it('parses a realistic board card', () => {
    expect(boardCardSchema.safeParse(makeBoardCard()).success).toBe(true);
  });

  it('accepts inColumnSinceMs: null (no status-change event to read)', () => {
    const result = boardCardSchema.safeParse(makeBoardCard({ inColumnSinceMs: null }));
    expect(result.success).toBe(true);
  });

  it('requires untouchedForMs to be a number (always present, per the header comment)', () => {
    const result = boardCardSchema.safeParse(makeBoardCard({ untouchedForMs: null }));
    expect(result.success).toBe(false);
  });
});

describe('boardColumnSchema', () => {
  it('parses a realistic column with cards', () => {
    const result = boardColumnSchema.safeParse({
      status: 'open',
      label: 'Open',
      wipLimit: 5,
      overWip: false,
      cards: [makeBoardCard()],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a null wipLimit (advisory, never enforced)', () => {
    const result = boardColumnSchema.safeParse({
      status: 'open',
      label: 'Open',
      wipLimit: null,
      overWip: false,
      cards: [],
    });
    expect(result.success).toBe(true);
  });
});

describe('boardViewSchema', () => {
  function makeBoardView(overrides: Record<string, unknown> = {}) {
    return {
      board: makeBoard(),
      columns: [
        { status: 'open', label: 'Open', wipLimit: null, overWip: false, cards: [makeBoardCard()] },
      ],
      unplaced: [],
      totalCards: 1,
      ...overrides,
    };
  }

  it('parses a full realistic board view', () => {
    const result = boardViewSchema.safeParse(makeBoardView());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.columns).toHaveLength(1);
      expect(result.data.columns[0]?.cards).toHaveLength(1);
    }
  });

  it('surfaces cards under unplaced rather than dropping them', () => {
    const result = boardViewSchema.safeParse(
      makeBoardView({ unplaced: [makeBoardCard({ cardId: 'orphan' })] })
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.unplaced).toHaveLength(1);
      expect(result.data.unplaced[0]?.cardId).toBe('orphan');
    }
  });

  it('rejects a malformed nested board', () => {
    const result = boardViewSchema.safeParse(makeBoardView({ board: { id: 'b1' } }));
    expect(result.success).toBe(false);
  });
});
