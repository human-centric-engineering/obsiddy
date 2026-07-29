/**
 * Unit Tests: repo shared primitives (Release 1, phase 2).
 *
 * `isRecordNotFound` / `isUniqueConstraintViolation` / `nullOnMiss` are the
 * plumbing that makes "not found" and "not yours" the same 404 (see the
 * file-level docblock on `shared.ts`). `pageArgs` is the one place `take`/
 * `skip` defaults live. None of this is exercised directly today —
 * `isolation.test.ts` only ever hits the `mockResolvedValue` happy path, so
 * the catch branch in `nullOnMiss` and the short-circuits in the two Prisma
 * error-code guards have zero coverage.
 *
 * @see lib/framework/obsiddy/repo/shared.ts
 */

import { describe, it, expect } from 'vitest';

import {
  DEFAULT_PAGE_SIZE,
  isRecordNotFound,
  isUniqueConstraintViolation,
  nullOnMiss,
  pageArgs,
} from '@/lib/framework/obsiddy/repo/shared';

describe('isRecordNotFound', () => {
  it('recognizes Prisma P2025 (record required but not found)', () => {
    expect(isRecordNotFound({ code: 'P2025' })).toBe(true);
  });

  it('rejects a differently-coded Prisma error', () => {
    expect(isRecordNotFound({ code: 'P2002' })).toBe(false);
  });

  it.each([
    ['null', null],
    ['a bare string', 'P2025'],
    ['an object with no code field', {}],
  ])('returns false for %s', (_label, input) => {
    expect(isRecordNotFound(input)).toBe(false);
  });
});

describe('isUniqueConstraintViolation', () => {
  it('recognizes Prisma P2002 (unique constraint)', () => {
    expect(isUniqueConstraintViolation({ code: 'P2002' })).toBe(true);
  });

  it.each([
    ['a differently-coded Prisma error', { code: 'P2025' }],
    ['null', null],
    ['an object with no code field', {}],
  ])('returns false for %s', (_label, input) => {
    expect(isUniqueConstraintViolation(input)).toBe(false);
  });
});

describe('nullOnMiss', () => {
  it('resolves to null when the operation rejects with a P2025-shaped error', async () => {
    // Arrange: a scoped update/delete that matched no row — the caller's or
    // someone else's — looks identical to Prisma.
    const notFoundError = Object.assign(new Error('not found'), { code: 'P2025' });
    const operation = () => Promise.reject(notFoundError);

    // Act
    const result = await nullOnMiss(operation);

    // Assert
    expect(result).toBeNull();
  });

  it('rethrows an error that is not a P2025 miss', async () => {
    // Arrange: a dead database must not be swallowed and reported as "not found".
    const connectionError = new Error('connection refused');
    const operation = () => Promise.reject(connectionError);

    // Act / Assert
    await expect(nullOnMiss(operation)).rejects.toBe(connectionError);
  });
});

describe('pageArgs', () => {
  it('defaults take and skip when called with no options', () => {
    expect(pageArgs()).toEqual({ take: DEFAULT_PAGE_SIZE, skip: 0 });
  });

  it('defaults only skip when take is provided', () => {
    expect(pageArgs({ take: 10 })).toEqual({ take: 10, skip: 0 });
  });

  it('defaults only take when skip is provided', () => {
    expect(pageArgs({ skip: 5 })).toEqual({ take: DEFAULT_PAGE_SIZE, skip: 5 });
  });

  it('uses both values as-is when both are provided', () => {
    expect(pageArgs({ take: 10, skip: 5 })).toEqual({ take: 10, skip: 5 });
  });
});
