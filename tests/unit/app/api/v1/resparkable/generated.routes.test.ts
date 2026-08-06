/**
 * Unit Tests: the generated board and tag routes.
 *
 * `app/api/v1/resparkable/boards/route.ts`, `.../boards/[id]/route.ts`,
 * `.../boards/[id]/restore/route.ts`, `.../tags/route.ts` and `.../tags/[id]/route.ts`
 * carry no logic of their own — each is a one-line re-export that hands a resource
 * descriptor to a shared factory in `api/handlers.ts` (already covered directly by
 * its own tests). The only thing that can go wrong at THIS layer is wiring: a route
 * built from the wrong resource would silently serve, update or restore the wrong
 * table while looking identical on screen — nothing else in the suite would catch
 * that, because the factory tests never see these files and the handler tests never
 * see these resources.
 *
 * So each case here does two things: (1) proves the expected HTTP verbs are actually
 * exported as callable functions, and (2) proves the factory was invoked with the
 * SPECIFIC resource object the route file claims to use — the wiring assertion that
 * would fail if `tags/route.ts` were accidentally wired to `boardResource`, or vice
 * versa.
 *
 * @see app/api/v1/resparkable/boards/route.ts
 * @see app/api/v1/resparkable/boards/[id]/route.ts
 * @see app/api/v1/resparkable/boards/[id]/restore/route.ts
 * @see app/api/v1/resparkable/tags/route.ts
 * @see app/api/v1/resparkable/tags/[id]/route.ts
 * @see lib/framework/resparkable/api/handlers.ts
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/framework/resparkable/api/handlers', () => ({
  createCollectionHandlers: vi.fn(() => ({ GET: vi.fn(), POST: vi.fn() })),
  createItemHandlers: vi.fn(() => ({ GET: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() })),
  createRestoreHandler: vi.fn(() => ({ POST: vi.fn() })),
}));

// Sentinel resource objects — distinct references so a wiring mistake (a route
// calling the factory with the wrong one) is something `toHaveBeenCalledWith`
// can actually catch, rather than two equal-looking plain objects.
vi.mock('@/lib/framework/resparkable/services/resources', () => ({
  boardResource: { name: 'board' },
  tagResource: { name: 'tag' },
}));

import {
  createCollectionHandlers,
  createItemHandlers,
  createRestoreHandler,
} from '@/lib/framework/resparkable/api/handlers';
import { boardResource, tagResource } from '@/lib/framework/resparkable/services/resources';

const mockedCreateCollectionHandlers = vi.mocked(createCollectionHandlers);
const mockedCreateItemHandlers = vi.mocked(createItemHandlers);
const mockedCreateRestoreHandler = vi.mocked(createRestoreHandler);

describe('GET/POST /api/v1/resparkable/boards', () => {
  it('wires GET and POST from createCollectionHandlers(boardResource)', async () => {
    const route = await import('@/app/api/v1/resparkable/boards/route');

    expect(typeof route.GET).toBe('function');
    expect(typeof route.POST).toBe('function');
    expect(mockedCreateCollectionHandlers).toHaveBeenCalledWith(boardResource);
  });
});

describe('GET/PATCH/DELETE /api/v1/resparkable/boards/[id]', () => {
  it('wires GET, PATCH and DELETE from createItemHandlers(boardResource)', async () => {
    const route = await import('@/app/api/v1/resparkable/boards/[id]/route');

    expect(typeof route.GET).toBe('function');
    expect(typeof route.PATCH).toBe('function');
    expect(typeof route.DELETE).toBe('function');
    expect(mockedCreateItemHandlers).toHaveBeenCalledWith(boardResource);
  });
});

describe('POST /api/v1/resparkable/boards/[id]/restore', () => {
  it('wires POST from createRestoreHandler(boardResource)', async () => {
    const route = await import('@/app/api/v1/resparkable/boards/[id]/restore/route');

    expect(typeof route.POST).toBe('function');
    expect(mockedCreateRestoreHandler).toHaveBeenCalledWith(boardResource);
  });
});

describe('GET/POST /api/v1/resparkable/tags', () => {
  it('wires GET and POST from createCollectionHandlers(tagResource)', async () => {
    const route = await import('@/app/api/v1/resparkable/tags/route');

    expect(typeof route.GET).toBe('function');
    expect(typeof route.POST).toBe('function');
    expect(mockedCreateCollectionHandlers).toHaveBeenCalledWith(tagResource);
  });
});

describe('GET/PATCH/DELETE /api/v1/resparkable/tags/[id]', () => {
  it('wires GET, PATCH and DELETE from createItemHandlers(tagResource)', async () => {
    const route = await import('@/app/api/v1/resparkable/tags/[id]/route');

    expect(typeof route.GET).toBe('function');
    expect(typeof route.PATCH).toBe('function');
    expect(typeof route.DELETE).toBe('function');
    expect(mockedCreateItemHandlers).toHaveBeenCalledWith(tagResource);
  });
});
