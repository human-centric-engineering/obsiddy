/**
 * Shared repo primitives — pagination, sort direction, and the "not found"
 * convention every Resparkable repo follows.
 *
 * **Not-found and not-yours are the same answer.** A repo write targets
 * `{ id, userId }` together, so another user's id simply matches no row and the
 * repo returns `null`, which routes turn into a 404. There is deliberately no
 * path that finds the row first and then compares owners: that shape leaks
 * existence through the difference between 403 and 404, and it invites a
 * check-then-act race. See the plan's isolation suite (§16.2) — "B GETs A's
 * project → **404 not 403**".
 */

import type { ArchiveVisibility, OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';

/** Sort direction accepted by the list endpoints. */
export type SortDirection = 'asc' | 'desc';

/** Page window. `take` is capped by the route's Zod schema, not here. */
export interface PageOptions {
  take?: number;
  skip?: number;
}

/** Everything a list call takes beyond its own filters. */
export interface ListOptions extends PageOptions {
  /** `false` hides the archive, `true` mixes it in, `'only'` shows it alone. */
  includeArchived?: ArchiveVisibility;
}

export const DEFAULT_PAGE_SIZE = 50;

/**
 * Prisma's "record required but not found" code, raised by `update`/`delete`
 * when the `where` matched nothing — which, for us, means either the row does
 * not exist or it belongs to somebody else. Both are `null`.
 */
export function isRecordNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2025';
}

/** Prisma's unique-constraint code — a slug collision within one user's space. */
export function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

/**
 * Run a scoped `update`/`delete` that should resolve to `null` when the row
 * isn't the caller's. Rethrows anything that isn't a miss — a connection error
 * must not read as "not found".
 */
export async function nullOnMiss<T>(operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    if (isRecordNotFound(error)) return null;
    throw error;
  }
}

/** Normalise page options to Prisma's `take`/`skip`. */
export function pageArgs(options: PageOptions = {}): { take: number; skip: number } {
  return {
    take: options.take ?? DEFAULT_PAGE_SIZE,
    skip: options.skip ?? 0,
  };
}

/**
 * Type-level guard used by the repo modules: a create payload must not carry
 * `userId`, because the repo injects it from the scope. If a caller could pass
 * one, `POST { userId: <someone else> }` becomes a write into another user's
 * brain — isolation test 2 in the plan ("B cannot create a row with
 * `userId: A` via the body").
 */
export type WithoutOwner<T> = Omit<T, 'userId' | 'id' | 'createdAt' | 'updatedAt'>;

/** Re-exported for repo modules so they import one path, not two. */
export type { ArchiveVisibility, OwnerScope };
