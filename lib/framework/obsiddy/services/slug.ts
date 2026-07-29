/**
 * Slug generation for the three named types (area, project, entity).
 *
 * Slugs are unique **per user**, not globally (`@@unique([userId, slug])`), so
 * two people can both have `acme` and neither learns the other exists.
 *
 * **On the duplicated `slugify`:** Sunrise has one, in
 * `lib/orchestration/knowledge/chunker.ts` — but importing it drags the
 * semantic chunker (and transitively the embedder) into every CRUD route
 * bundle for a five-line string transform. Upstream #451 proposes relocating it
 * to a shared `lib/utils.ts`, which is exactly the fix; until then this copy
 * follows the same rule (lowercase, non-alphanumerics to single hyphens, no
 * leading/trailing hyphen, 60 chars) so the two cannot diverge in behaviour.
 */

import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';

/** Same rule as `lib/orchestration/knowledge/chunker.ts` — see the note above. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/** How many `-2`, `-3`… attempts before giving up and using a random suffix. */
const MAX_SUFFIX_ATTEMPTS = 50;

/**
 * Resolve a slug that is free within this user's space.
 *
 * @param preferred - An explicit slug from the request, if the user set one.
 * @param fallbackFrom - The display name to derive from when they didn't.
 * @param exists - Owner-scoped existence check (the repo's `findBySlug`).
 *
 * A name that slugifies to nothing — "!!!", or a title in a script this rule
 * strips entirely — still needs a slug, so it falls back to `item`. Returning
 * an empty string would violate the unique index in a way that reads as a
 * database error rather than "we couldn't name this".
 */
export async function resolveUniqueSlug(
  scope: OwnerScope,
  {
    preferred,
    fallbackFrom,
    exists,
  }: {
    preferred?: string | null;
    fallbackFrom: string;
    exists: (scope: OwnerScope, slug: string) => Promise<unknown>;
  }
): Promise<string> {
  const base = slugify(preferred ?? fallbackFrom) || 'item';

  if (!(await exists(scope, base))) return base;

  for (let attempt = 2; attempt <= MAX_SUFFIX_ATTEMPTS; attempt += 1) {
    const candidate = `${base}-${attempt}`.slice(0, 60);
    if (!(await exists(scope, candidate))) return candidate;
  }

  // 50 collisions on one base name means something pathological (a script
  // creating "Untitled" in a loop). A random suffix always terminates; the
  // alternative is an endless probe or a 500 on an otherwise valid create.
  return `${base}-${Math.floor(performance.now()).toString(36)}`.slice(0, 60);
}

/**
 * The slug to use when a rename should NOT move the URL.
 *
 * Renaming an item deliberately leaves its slug alone: the slug is an address,
 * and silently changing it breaks vault filenames (Release 3), share links
 * (Release 2) and anything the user bookmarked. A slug changes only when the
 * request explicitly sets one.
 */
export async function resolveSlugOnUpdate(
  scope: OwnerScope,
  {
    current,
    requested,
    exists,
  }: {
    current: string;
    requested?: string | null;
    exists: (scope: OwnerScope, slug: string) => Promise<unknown>;
  }
): Promise<string> {
  if (!requested) return current;
  const candidate = slugify(requested) || current;
  if (candidate === current) return current;
  return resolveUniqueSlug(scope, { preferred: candidate, fallbackFrom: candidate, exists });
}
