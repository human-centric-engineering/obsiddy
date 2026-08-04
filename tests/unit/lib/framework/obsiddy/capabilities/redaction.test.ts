/**
 * Unit Tests: what each capability persists onto the durable audit row.
 *
 * `redactProvenance` decides what is copied onto `AiMessage.provenance`, and
 * that row is **outside the Obsiddy erasure cascade**. Everything a capability
 * keeps there is a second copy of someone's notes that "delete my account" does
 * not reach. The rule the tier follows is *prose out, structure in*: a status, a
 * horizon, a due date and a foreign key say what happened and are worth keeping;
 * a title, a note body, a rationale and a person's name are the user's own words
 * about their work, their health and the people around them.
 *
 * These tests exist because the failure is invisible from every other angle. A
 * capability that persists a whole note verbatim behaves identically, returns
 * the same result, and passes every other test in this directory.
 *
 * Test Coverage:
 * - Captured content never reaches the audit row; its length does
 * - Search queries and hit titles are absent; ids and scores survive
 * - Upsert titles, notes and descriptions are masked; ids and statuses are not
 * - A person's name AND website are masked — a third party never opted in
 * - The snapshot keeps nothing at all, because there is no useful partial form
 * - A key the caller never sent is not invented by the masking
 *
 * @see lib/framework/obsiddy/capabilities/base.ts — `maskFreeText`
 */

import { describe, it, expect } from 'vitest';

import { maskFreeText } from '@/lib/framework/obsiddy/capabilities/base';
import { ObsiddyCaptureCapability } from '@/lib/framework/obsiddy/capabilities/capture';
import { ObsiddySearchCapability } from '@/lib/framework/obsiddy/capabilities/search';
import { ObsiddyUpsertTaskCapability } from '@/lib/framework/obsiddy/capabilities/tasks';
import { ObsiddyUpsertEntityCapability } from '@/lib/framework/obsiddy/capabilities/records';
import { ObsiddyGetSnapshotCapability } from '@/lib/framework/obsiddy/capabilities/snapshot';
import { ObsiddyWriteReviewCapability } from '@/lib/framework/obsiddy/capabilities/reviews';
import { ObsiddyLinkEntitiesCapability } from '@/lib/framework/obsiddy/capabilities/links';

const ID = (n: number) => `clh000000000000000000000${n}`;

/** Everything the audit row would carry, as one string, for absence assertions. */
function persisted(redaction: { args: unknown; resultPreview: string }): string {
  return `${JSON.stringify(redaction.args)} ${redaction.resultPreview}`;
}

describe('maskFreeText', () => {
  it('masks the named keys and leaves the structural ones alone', () => {
    const masked = maskFreeText({ title: 'Call the clinic', status: 'todo' }, ['title']);

    expect(masked.status).toBe('todo');
    expect(masked.title).not.toContain('clinic');
    expect(String(masked.title)).toContain('15 chars');
  });

  it('does not invent a key the caller never sent', () => {
    // A masked key that was never supplied would make the audit row claim a
    // field was set — which is worse than omitting it, because it reads as fact.
    const masked = maskFreeText<{ status: string; title?: string; notes?: string }>(
      { status: 'done' },
      ['title', 'notes']
    );

    expect(Object.keys(masked)).toEqual(['status']);
  });
});

describe('obsiddy_capture provenance', () => {
  it('keeps the length and the dedupe outcome, never the thought', () => {
    const capability = new ObsiddyCaptureCapability();
    const redaction = capability.redactProvenance(
      { content: 'the biopsy results are back and I have not opened the letter' },
      { success: true, data: { id: ID(1), deduped: false, capturedAt: '2026-08-04T09:00:00.000Z' } }
    );

    expect(persisted(redaction)).not.toContain('biopsy');
    expect(JSON.stringify(redaction.args)).toContain('60 chars');
    expect(redaction.resultPreview).toContain('"deduped":false');
  });

  it('keeps externalId — a replay id is a routing fact, not content', () => {
    const capability = new ObsiddyCaptureCapability();
    const redaction = capability.redactProvenance(
      { content: 'x', externalId: 'postmark-abc' },
      { success: true, data: { id: ID(1), deduped: true, capturedAt: '2026-08-04T09:00:00.000Z' } }
    );

    expect(JSON.stringify(redaction.args)).toContain('postmark-abc');
  });
});

describe('obsiddy_search provenance', () => {
  it('keeps ids and scores, drops the query and every title', () => {
    const capability = new ObsiddySearchCapability();
    const redaction = capability.redactProvenance(
      { query: 'what did I decide about the redundancy', limit: 10, includeArchived: false },
      {
        success: true,
        data: {
          hits: [
            {
              id: ID(1),
              entityType: 'thought',
              title: 'Redundancy conversation with Sam',
              subtitle: null,
              score: 0.8,
              matchedBy: 'semantic',
              snippet: 'Sam said',
              archived: false,
            },
          ],
          sources: [],
        },
      }
    );

    const row = persisted(redaction);
    expect(row).not.toContain('redundancy');
    expect(row).not.toContain('Sam');
    // An id resolves to nothing once the row is erased; a title would survive
    // inside the audit bundle. That asymmetry is why refs are the line.
    expect(row).toContain(`thought:${ID(1)}`);
    expect(row).toContain('"hitCount":1');
  });
});

describe('upsert provenance', () => {
  it('masks a task title and notes but keeps the status and the id', () => {
    const capability = new ObsiddyUpsertTaskCapability();
    const redaction = capability.redactProvenance(
      {
        id: ID(1),
        title: 'Draft the redundancy letter',
        notes: 'mention the March date',
        status: 'doing',
      },
      {
        success: true,
        data: { id: ID(1), action: 'updated', label: 'Draft the redundancy letter' },
      }
    );

    const row = persisted(redaction);
    expect(row).not.toContain('redundancy');
    expect(row).not.toContain('March');
    expect(row).toContain('"status":"doing"');
    expect(row).toContain(ID(1));
  });

  /**
   * The one capability whose `name` is usually a third party's. They never
   * agreed to appear in an audit bundle, and a personal domain identifies
   * someone as squarely as their name does.
   */
  it('masks a person’s name and their website', () => {
    const capability = new ObsiddyUpsertEntityCapability();
    const redaction = capability.redactProvenance(
      { name: 'Priya Raman', website: 'https://priyaraman.co.uk', kind: 'person' },
      { success: true, data: { id: ID(2), action: 'created', label: 'Priya Raman' } }
    );

    const row = persisted(redaction);
    expect(row).not.toContain('Priya');
    expect(row).not.toContain('priyaraman');
    expect(row).toContain('"kind":"person"');
  });
});

describe('obsiddy_link_entities provenance', () => {
  it('keeps both endpoints — the assertion is the point of the audit row', () => {
    const capability = new ObsiddyLinkEntitiesCapability();
    const redaction = capability.redactProvenance(
      {
        sourceType: 'project',
        sourceId: ID(1),
        targetType: 'goal',
        targetId: ID(2),
        kind: 'supports',
        rationale: 'because the launch pays for the sabbatical',
      },
      {
        success: true,
        data: {
          id: ID(3),
          sourceType: 'project',
          sourceId: ID(1),
          targetType: 'goal',
          targetId: ID(2),
          kind: 'supports',
        },
      }
    );

    const row = persisted(redaction);
    expect(row).toContain(ID(1));
    expect(row).toContain(ID(2));
    expect(row).toContain('supports');
    expect(row).not.toContain('sabbatical');
  });
});

describe('obsiddy_write_review provenance', () => {
  it('keeps the horizon and the run id, masks the prose and the payload', () => {
    const capability = new ObsiddyWriteReviewCapability();
    const redaction = capability.redactProvenance(
      {
        horizon: 'weekly',
        title: 'Week 32 — the sabbatical decision',
        body: 'You finished the pricing work and dropped the newsletter.',
        payload: { taskIds: [ID(1)] },
        workflowExecutionId: 'exec-9',
      },
      {
        success: true,
        data: { id: ID(4), horizon: 'weekly', generatedAt: '2026-08-04T09:00:00.000Z' },
      }
    );

    const row = persisted(redaction);
    expect(row).toContain('"horizon":"weekly"');
    expect(row).toContain('exec-9');
    expect(row).not.toContain('sabbatical');
    expect(row).not.toContain('newsletter');
  });
});

describe('obsiddy_get_snapshot provenance', () => {
  /**
   * The nuclear option, deliberately. A snapshot minus its content is a set of
   * counts, and the counts are already in the payload the model received — so
   * there is no partial form worth the second copy.
   */
  it('records that a snapshot was taken and nothing about what was in it', () => {
    const capability = new ObsiddyGetSnapshotCapability();
    const redaction = capability.redactProvenance(
      {},
      {
        success: true,
        data: {
          generatedAt: '2026-08-04T09:00:00.000Z',
          timezone: 'Europe/London',
          goals: { items: [{ title: 'Take a sabbatical' }], truncated: false },
        } as never,
      }
    );

    expect(persisted(redaction)).not.toContain('sabbatical');
    expect(redaction.resultPreview).toContain('full brain snapshot');
  });
});
