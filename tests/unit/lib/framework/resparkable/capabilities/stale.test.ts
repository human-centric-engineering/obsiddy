/**
 * Unit Tests: `resparkable_get_stale_digest`.
 *
 * The one capability whose entire job is to hand the model something it must
 * not be able to act on: four dormancy questions, never a verdict. Two things
 * are worth proving here that no other test in this directory covers —
 *
 *   - The digest is built for the **caller's own scope**, not some default or
 *     borrowed one. A capability that called `buildStaleDigest` with the wrong
 *     scope would return a plausible-looking digest belonging to someone else,
 *     and every other assertion in this file would still pass.
 *   - There is no "still-live" capability at all. §11 puts the archive/dismiss
 *     decision with a human; binding that restraint at the catalogue level
 *     means there is nothing for an agent to be tempted by, rather than a
 *     tool description asking it not to.
 *   - `redactProvenance` does not read the digest's contents at all — the
 *     result is replaced with a fixed summary regardless of what came back,
 *     so no project, goal, area or person name in the digest can ever reach
 *     `AiMessage.provenance`.
 *
 * @see lib/framework/resparkable/capabilities/stale.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/resparkable/services/stale-digest', () => ({ buildStaleDigest: vi.fn() }));

import { ResparkableGetStaleDigestCapability } from '@/lib/framework/resparkable/capabilities/stale';
import {
  RESPARKABLE_CAPABILITIES,
  RESPARKABLE_CAPABILITY_SLUGS,
} from '@/lib/framework/resparkable/capabilities/catalogue';
import { resparkableCapabilityHandlers } from '@/lib/framework/resparkable/capabilities';
import { buildStaleDigest } from '@/lib/framework/resparkable/services/stale-digest';
import type { StaleDigest } from '@/lib/framework/resparkable/services/stale-digest';
import type { CapabilityContext } from '@/lib/orchestration/capabilities/types';

const mockedBuildStaleDigest = vi.mocked(buildStaleDigest);

const CONTEXT: CapabilityContext = { userId: 'user_a', agentId: 'workflow:wf_1' };

function capability() {
  return new ResparkableGetStaleDigestCapability();
}

/** A digest carrying a recognisable third-party name, for the leak assertion below. */
function digestWithEntityName(name: string): StaleDigest {
  return {
    generatedAt: '2026-08-04T09:00:00.000Z',
    total: 1,
    sections: [
      { type: 'project', windowDays: 90, rows: [] },
      { type: 'goal', windowDays: 90, rows: [] },
      { type: 'area', windowDays: 60, rows: [] },
      {
        type: 'entity',
        windowDays: 90,
        rows: [
          { id: 'clh0000000000000000000001', title: name, lastSignalAt: null, quietDays: null },
        ],
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resparkable_get_stale_digest — what it does', () => {
  it('builds the digest for the caller’s own scope and returns it unchanged', async () => {
    const digest = digestWithEntityName('Acme Corp');
    mockedBuildStaleDigest.mockResolvedValue(digest);

    const cap = capability();
    const result = await cap.execute(cap.validate({}), CONTEXT);

    // Anti-green-bar: prove the capability passed the caller's OWN scope
    // through, not just that it returned whatever the mock handed back.
    expect(buildStaleDigest).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user_a' }));
    expect(buildStaleDigest).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true, data: digest });
  });

  it('scopes a second caller independently — no scope is shared or reused', async () => {
    mockedBuildStaleDigest.mockResolvedValue(digestWithEntityName('Acme Corp'));
    const cap = capability();

    await cap.execute(cap.validate({}), { userId: 'user_b', agentId: 'workflow:wf_1' });

    expect(buildStaleDigest).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user_b' }));
    expect(buildStaleDigest).not.toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_a' })
    );
  });

  it('takes no arguments and rejects any', () => {
    const cap = capability();

    expect(() => cap.validate({})).not.toThrow();
    expect(() => cap.validate({ windowDays: 30 })).toThrow();
    expect(() => cap.validate({ userId: 'user_a' })).toThrow();
  });

  it('refuses an ownerless run before reaching the service — nothing is read', async () => {
    const cap = capability();

    const result = await cap.execute(cap.validate({}), { userId: null, agentId: 'workflow:wf_1' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('no_user_context');
    expect(buildStaleDigest).not.toHaveBeenCalled();
  });
});

describe('resparkable_get_stale_digest — read-only by construction', () => {
  /**
   * §11 puts the archive/dismiss decision with a human. The binding is at the
   * catalogue level, not a tool description: `resparkable_still_live` (or any
   * "confirm dormant" write) must not exist as a registered slug, so there is
   * nothing an agent could reach for even if a prompt suggested it.
   */
  it('is the only stale-related capability registered — no "still-live" write exists', () => {
    const slugs = Object.values(RESPARKABLE_CAPABILITY_SLUGS);

    expect(slugs).toContain('resparkable_get_stale_digest');
    for (const slug of slugs) {
      expect(slug).not.toMatch(/still.?live/i);
    }

    const catalogueSlugs = RESPARKABLE_CAPABILITIES.map((spec) => spec.slug);
    expect(catalogueSlugs).toContain('resparkable_get_stale_digest');
    for (const slug of catalogueSlugs) {
      expect(slug).not.toMatch(/still.?live/i);
    }

    const handlerSlugs = resparkableCapabilityHandlers().map((handler) => handler.slug);
    expect(handlerSlugs).toContain('resparkable_get_stale_digest');
    for (const slug of handlerSlugs) {
      expect(slug).not.toMatch(/still.?live/i);
    }
  });

  it('is marked idempotent — a safe, side-effect-free read', () => {
    const spec = RESPARKABLE_CAPABILITIES.find(
      (candidate) => candidate.slug === RESPARKABLE_CAPABILITY_SLUGS.getStaleDigest
    );

    expect(spec?.isIdempotent).toBe(true);
  });
});

describe('resparkable_get_stale_digest — provenance', () => {
  it('keeps the (empty) args shape and replaces the result with a fixed summary', () => {
    const cap = capability();
    const args = cap.validate({});

    const redaction = cap.redactProvenance(args, {
      success: true,
      data: digestWithEntityName('Acme Corp'),
    });

    expect(redaction.args).toEqual({});
    expect(redaction.resultPreview).toContain('stale digest');
  });

  /**
   * The security-relevant assertion in this file. The digest's `entity`
   * section carries third-party names by design (§11 — "you haven't touched
   * Acme since April"), and `AiMessage.provenance` sits outside the erasure
   * cascade: an id there resolves to nothing once the row is erased, but
   * "Acme Corp" persisted verbatim would survive forever. Stringify the whole
   * redaction — args and resultPreview both — so a name smuggled into either
   * half would still be caught.
   */
  it('never lets a project, goal, area or person name reach the audit row', () => {
    const cap = capability();
    const digest = digestWithEntityName('Acme Corp');

    const redaction = cap.redactProvenance(cap.validate({}), { success: true, data: digest });
    const persisted = JSON.stringify(redaction);

    expect(persisted).not.toContain('Acme Corp');
    expect(persisted).not.toContain('Acme');
  });

  it('redacts the same way regardless of what the digest actually contains', () => {
    // The point of `auditArgsKeepShape` here is that it does not inspect the
    // result at all — proven by two very different digests producing an
    // identical redaction.
    const cap = capability();
    const empty: StaleDigest = { generatedAt: '2026-08-04T09:00:00.000Z', total: 0, sections: [] };
    const full = digestWithEntityName('Priya Raman — Longtail Studio');

    const redactionEmpty = cap.redactProvenance(cap.validate({}), { success: true, data: empty });
    const redactionFull = cap.redactProvenance(cap.validate({}), { success: true, data: full });

    expect(redactionEmpty).toEqual(redactionFull);
    expect(JSON.stringify(redactionFull)).not.toContain('Priya');
  });

  it('records a failure without inventing a digest', () => {
    const cap = capability();

    const redaction = cap.redactProvenance(cap.validate({}), {
      success: false,
      error: { code: 'no_user_context', message: 'no owner' },
    });

    expect(redaction.args).toEqual({});
    expect(redaction.resultPreview).toContain('stale digest');
  });
});
