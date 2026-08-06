/**
 * Unit Tests: `registerResparkableRateLimits`.
 *
 * These sub-caps sit on top of the 100/min section cap `/api/v1/**` already
 * inherits from `proxy.ts`, and they exist for flows where one request is
 * expensive rather than cheap. Two properties are worth holding, and neither is
 * visible from the app:
 *
 *   1. **Every matcher stays inside `/api/v1/resparkable/`.** `registerRateLimitRule`
 *      throws if a matcher could shadow a Resparkable-protected surface, so a
 *      careless prefix fails at boot — but only if something actually calls the
 *      registrar. This test is that call.
 *   2. **Every rule is keyed on the session user, not the IP.** IP keying would
 *      make one household share a search budget, and this is authenticated
 *      per-person work.
 *
 * The registrar is also idempotent by necessity: Next re-evaluates the
 * middleware module on every hot reload in dev, so a registrar that appended on
 * each call would grow the policy table without bound.
 *
 * @see lib/framework/resparkable/rate-limit.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/security/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/security/rate-limit')>();
  return { ...actual, registerRateLimitTier: vi.fn() };
});

vi.mock('@/lib/security/rate-limit-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/security/rate-limit-policy')>();
  return { ...actual, registerRateLimitRule: vi.fn() };
});

import { registerResparkableRateLimits } from '@/lib/framework/resparkable/rate-limit';
import { registerRateLimitTier } from '@/lib/security/rate-limit';
import { registerRateLimitRule } from '@/lib/security/rate-limit-policy';

const mockedTier = vi.mocked(registerRateLimitTier);
const mockedRule = vi.mocked(registerRateLimitRule);

/** Every path the caps are meant to cover, and the tier each should land on. */
const EXPECTED: Array<{ path: string; tier: string }> = [
  { path: '/api/v1/resparkable/search', tier: 'resparkable-search' },
  { path: '/api/v1/resparkable/reindex', tier: 'resparkable-batch' },
  { path: '/api/v1/resparkable/connections/sweep', tier: 'resparkable-batch' },
  { path: '/api/v1/resparkable/documents', tier: 'resparkable-upload' },
  { path: '/api/v1/resparkable/ideate', tier: 'resparkable-ideate' },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('registerResparkableRateLimits', () => {
  it('registers a tier for each cap, including the ideate one', () => {
    registerResparkableRateLimits();

    const names = mockedTier.mock.calls.map((call) => call[0]);
    expect(names).toEqual(
      expect.arrayContaining([
        'resparkable-search',
        'resparkable-batch',
        'resparkable-upload',
        'resparkable-ideate',
      ])
    );
  });

  it('registers a rule for every capped path, on the right tier', () => {
    registerResparkableRateLimits();

    const rules = mockedRule.mock.calls.map((call) => call[0]);

    for (const { path, tier } of EXPECTED) {
      const rule = rules.find((candidate) =>
        candidate.match instanceof RegExp ? candidate.match.test(path) : false
      );
      expect(rule, `no rate-limit rule matches ${path}`).toBeDefined();
      expect(rule?.tier, `${path} landed on the wrong tier`).toBe(tier);
    }
  });

  it('keys every rule on the session user, never the IP', () => {
    // IP keying would make one household share a search budget. This is
    // authenticated, per-person work.
    registerResparkableRateLimits();

    for (const [rule] of mockedRule.mock.calls) {
      expect(rule.key).toBe('session-user');
    }
  });

  it('scopes every matcher inside /api/v1/resparkable/', () => {
    // The registrar throws on a matcher that could shadow a Resparkable surface, but
    // only for the probes it knows about. Asserting the namespace directly means
    // a matcher that merely *could* widen is caught here rather than at boot.
    registerResparkableRateLimits();

    const foreignPaths = [
      '/api/v1/admin/orchestration/agents',
      '/api/v1/auth/sign-in',
      '/api/v1/chat/stream',
      '/api/v1/users/me',
    ];

    for (const [rule] of mockedRule.mock.calls) {
      for (const path of foreignPaths) {
        const matches = rule.match instanceof RegExp ? rule.match.test(path) : false;
        expect(matches, `${String(rule.match)} must not match ${path}`).toBe(false);
      }
    }
  });

  it('does not cap the plain capture path — it is cheap and must stay fast', () => {
    // Capture is the front door and writes one row. Putting it behind a sub-cap
    // would make the product's core gesture fail under exactly the burst a
    // person produces when emptying their head.
    registerResparkableRateLimits();

    for (const [rule] of mockedRule.mock.calls) {
      const matches =
        rule.match instanceof RegExp ? rule.match.test('/api/v1/resparkable/capture') : false;
      expect(matches).toBe(false);
    }
  });
});
