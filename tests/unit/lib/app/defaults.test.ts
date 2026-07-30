/**
 * Tests: lib/app/ bootstrap files ship as no-op defaults
 *
 * The auto-wired bootstrap hooks (`lib/app/rate-limit.ts`, `lib/app/capabilities.ts`,
 * `lib/app/context-contributors.ts`, `lib/app/admin-nav.ts`) must register NOTHING
 * out of the box — the template
 * ships them empty and forks fill them in. The wiring tests
 * (`bootstrap-wiring.test.ts`, `admin-nav-wiring.test.tsx`) replace these hooks
 * with registering versions; this file exercises the REAL defaults to lock in
 * the no-op contract (a stray default registration would silently apply to
 * every install).
 *
 * FORK NOTE (Obsiddy): this fork fills four of these seams — the ESLint config
 * (spreads the framework tier), `initApp` (boots Obsiddy), `registerAppRateLimits`
 * (Obsiddy's four per-flow sub-caps) and `initAppNav` (the Obsiddy admin
 * section). Their assertions
 * below are adjusted accordingly; every other seam still has to be a no-op, and
 * that is what this file is now protecting. The Obsiddy boot chain itself is
 * covered by tests/unit/lib/framework/obsiddy/scaffold.test.ts.
 *
 * @see lib/app/rate-limit.ts · lib/app/capabilities.ts · lib/app/admin-nav.ts
 */

import { describe, it, expect, afterEach } from 'vitest';
import { registerAppRateLimits } from '@/lib/app/rate-limit';
import { initAppCapabilities } from '@/lib/app/capabilities';
import { initAppContextContributors } from '@/lib/app/context-contributors';
import { initAppNav } from '@/lib/app/admin-nav';
import { publicNavItems, footerNavItems, footerLegalItems } from '@/lib/app/public-nav';
import { emailOverrides } from '@/lib/app/emails';
import { initApp } from '@/lib/app/bootstrap';
import { initAppKnowledgeAccessContributors } from '@/lib/app/knowledge-access-contributors';
import appEslintConfig from '@/lib/app/eslint.config.mjs';
import frameworkEslintConfig from '@/lib/framework/eslint.config.mjs';
import { getEffectiveRateLimitPolicy, RATE_LIMIT_POLICY } from '@/lib/security/rate-limit-policy';
import { getRegisteredNavSections, __resetNavRegistryForTests } from '@/lib/admin-nav/registry';

afterEach(() => {
  __resetNavRegistryForTests();
});

describe('lib/app/ bootstrap defaults are no-ops', () => {
  it('registerAppRateLimits registers exactly Obsiddy sub-caps and nothing else', () => {
    // FORK NOTE (Obsiddy): vanilla Sunrise asserts the effective policy is the
    // base policy *by identity* — no app rules at all. Obsiddy fills this seam
    // with per-flow sub-caps for its four expensive routes (every `/search`
    // request embeds the query; `/reindex` and `/connections/sweep` start batch
    // jobs; `/documents` parses an upload). The original intent is preserved by
    // asserting the exact set: a stray rule added to this seam still fails, and
    // so does a rule that escapes the /api/v1/obsiddy/ namespace.
    registerAppRateLimits();

    const effective = getEffectiveRateLimitPolicy();
    const appRules = effective.filter((rule) => !RATE_LIMIT_POLICY.includes(rule));

    expect(appRules.map((rule) => String(rule.match))).toEqual([
      String(/^\/api\/v1\/obsiddy\/search(?:\/|$)/),
      String(/^\/api\/v1\/obsiddy\/reindex(?:\/|$)/),
      String(/^\/api\/v1\/obsiddy\/connections\/sweep(?:\/|$)/),
      String(/^\/api\/v1\/obsiddy\/documents(?:\/|$)/),
    ]);

    // Every Obsiddy rule is keyed on the session user, not the IP: this is
    // authenticated per-person work, and IP keying would make one household
    // share a search budget.
    expect(appRules.every((rule) => rule.key === 'session-user')).toBe(true);

    // The catch-all must stay last — app rules are spliced in just ahead of it,
    // and a rule after it would never match.
    expect(effective[effective.length - 1]).toBe(RATE_LIMIT_POLICY[RATE_LIMIT_POLICY.length - 1]);
  });

  it('initAppCapabilities is a no-op by default', () => {
    // The real default does nothing and returns void; forks add
    // registerAppCapability() calls. (Behavioural reach into the dispatcher is
    // covered by bootstrap-wiring.test.ts.)
    expect(initAppCapabilities()).toBeUndefined();
  });

  it('initAppContextContributors is a no-op by default', () => {
    // The real default registers no prompt-context loaders and returns void;
    // forks add registerContextContributor() calls. (Behavioural reach into
    // buildContext is covered by context-builder.test.ts.)
    expect(initAppContextContributors()).toBeUndefined();
  });

  it('initAppNav registers exactly the Obsiddy admin section', () => {
    // FORK NOTE (Obsiddy): vanilla Sunrise asserts an empty registry. Obsiddy
    // adds one section for its instance settings. Asserting the exact shape keeps
    // the original intent — a stray section still fails — and pins the two things
    // that would break the sidebar if they drifted: the title must not collide
    // with a core section (the registry keys by title, so a collision yields two
    // siblings with the same React key), and the href must match the page that
    // actually exists.
    __resetNavRegistryForTests();

    initAppNav();

    const sections = getRegisteredNavSections();
    expect(sections).toHaveLength(1);
    expect(sections[0].title).toBe('Obsiddy');
    expect(sections[0].title).not.toBe('AI Orchestration');
    expect(sections[0].items?.map((item) => item.href)).toEqual(['/admin/obsiddy/settings']);
  });

  it('public-nav overrides are all null by default (= use platform defaults)', () => {
    // A stray non-null list here would silently replace the marketing nav for
    // every install (issue #347 ships these unset).
    expect(publicNavItems).toBeNull();
    expect(footerNavItems).toBeNull();
    expect(footerLegalItems).toBeNull();
  });

  it('email overrides are empty by default (= use platform templates)', () => {
    // A stray override here would silently swap an auth email for every install.
    expect(emailOverrides).toEqual({});
  });

  it('initApp boots the framework tier and resolves to undefined', async () => {
    // FORK NOTE (Obsiddy): vanilla Sunrise ships an empty async fn here and
    // this test locks that in; Obsiddy fills it to boot its tier. What still
    // matters — and is asserted — is that the boot chain resolves cleanly with
    // no return value, since instrumentation.ts awaits it inside a try/catch
    // and a rejection would leave the tier half-booted. The chain itself is
    // covered by tests/unit/lib/framework/obsiddy/scaffold.test.ts, and the
    // instrumentation wiring by tests/unit/instrumentation.test.ts.
    await expect(initApp()).resolves.toBeUndefined();
  });

  it('initAppKnowledgeAccessContributors is a no-op by default', () => {
    // The real default registers no access contributors and returns void; forks
    // add registerAgentAccessContributor() calls. A stray default would silently
    // widen every restricted agent's document access on every install.
    // (Behavioural reach into the resolver is covered by
    // resolveAgentDocumentAccess.test.ts.)
    expect(initAppKnowledgeAccessContributors()).toBeUndefined();
  });

  it('the ESLint config seam spreads the framework tier and nothing else', () => {
    // FORK NOTE (Obsiddy): vanilla Sunrise asserts `toEqual([])` here — the
    // seam ships empty and forks fill it. Obsiddy fills it with exactly one
    // thing: the framework tier's config, spread FIRST so any later leaf block
    // still wins for its own paths. Asserting identity with the tier array
    // (rather than a shape) keeps the original test's intent — a stray block
    // added straight to the leaf seam still fails.
    expect(appEslintConfig).toEqual(frameworkEslintConfig);
  });
});
