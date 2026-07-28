/**
 * Framework-tier ESLint config.
 *
 * Spread by `lib/app/eslint.config.mjs` **before** that file's own leaf blocks,
 * which the root `eslint.config.mjs` in turn spreads after every Sunrise core
 * block. Net order: core → framework (this file) → leaf. A later block wins for
 * overlapping `files`, so the leaf tier can still override the framework tier
 * for its own paths.
 *
 * **`no-restricted-imports` REPLACES, it does not merge.** Flat config does not
 * deep-merge rule options: a block that sets the rule for a glob fully replaces
 * any earlier setting for those files. Every block below therefore restates the
 * core `@/`-alias ban — omitting it would silently kill relative-import
 * enforcement on those paths — and the narrower `repo/**` block restates the
 * whole of the tier-wide block on top of its own rule.
 *
 * See CUSTOMIZATION.md §4, `lib/app/eslint.config.mjs`, and
 * `.context/architecture/lint-toolchain.md`.
 */

/** Restated from the core config — see the replace-not-merge note above. */
const aliasBan = {
  group: ['./*', '../*'],
  message: 'Use the @/ path alias instead of relative imports (CLAUDE.md).',
};

/**
 * The framework tier may only reach into the leaf tier through the two seams
 * Obsiddy deliberately re-exposes to its own leaf forks. Anything else is
 * inverted layering: the leaf depends on the framework, not the reverse.
 */
const leafTierBan = {
  group: ['@/lib/app/*', '!@/lib/app/leaf-bootstrap', '!@/lib/app/obsiddy'],
  message:
    'The framework tier must not import the leaf app tier. The only exceptions are the ' +
    'seams Obsiddy re-exposes to its leaf forks: @/lib/app/leaf-bootstrap and @/lib/app/obsiddy.',
};

export default [
  // ── Framework-tier import boundary ───────────────────────────────────────
  {
    files: ['lib/framework/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [aliasBan, leafTierBan] }],
    },
  },

  // ── D5: owner queries and shared queries are structurally separate ───────
  // `lib/framework/obsiddy/repo/*` takes an `OwnerScope` and must not be able
  // to express a cross-user read. Cross-user resolution lives in
  // `lib/framework/obsiddy/access/*`, and the repo layer must not reach it —
  // otherwise the "every brain query is an owner query or a shared query"
  // invariant becomes a convention rather than a structure. See the plan, D5.
  {
    files: ['lib/framework/obsiddy/repo/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            aliasBan,
            leafTierBan,
            {
              group: ['@/lib/framework/obsiddy/access', '@/lib/framework/obsiddy/access/*'],
              message:
                'The Obsiddy repo layer is owner-scoped by construction (D5) and must not import ' +
                'the cross-user access layer. Put shared-item reads in lib/framework/obsiddy/access/*.',
            },
          ],
        },
      ],
    },
  },
];
