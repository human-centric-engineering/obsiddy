/**
 * Unit Tests: the two vault routes.
 *
 *   GET  /api/v1/obsiddy/vault/export
 *   POST /api/v1/obsiddy/vault/import
 *
 * What these exist to pin down:
 *
 *   1. **Dry-run is the default, and the status code says which happened.** A
 *      plan comes back `202`, an applied import `200`. Getting this backwards
 *      would make a UI that reports "imported" for a run that wrote nothing —
 *      or, far worse, the reverse.
 *   2. **The flags are opt-in and go through Zod.** `apply` arrives as a form
 *      string; anything that is not the literal opt-in must be a dry run. This
 *      is the blast-radius control, so it is asserted at the route rather than
 *      trusted to the schema alone.
 *   3. **The size cap runs before `formData()`.** `formData()` materialises the
 *      whole body in memory, so a check afterwards has already lost. Asserted by
 *      spying on `formData` and proving it was never reached.
 *   4. **Export is a file, with the headers that make it one** — and
 *      `private, no-store`, because a brain export is personal data that must
 *      not sit in a shared cache.
 *   5. **A bad archive is the user's file being wrong, not a server fault.**
 *      `VaultZipError` and `VaultExportError` both become 400s carrying the
 *      specific reason, so the UI can say what to fix.
 *
 * Both routes are owner-scoped by construction — `ownerScope(session.user.id)`
 * is the only scope they can reach — and the tests assert the scope reaches the
 * service, because that is the seam a future refactor could quietly widen.
 *
 * @see app/api/v1/obsiddy/vault/export/route.ts
 * @see app/api/v1/obsiddy/vault/import/route.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/guards', () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, session: unknown, context: unknown) => {
      const { handleAPIError } = await import('@/lib/api/errors');
      try {
        return await handler(request, session, context);
      } catch (error) {
        return handleAPIError(error);
      }
    },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/framework/obsiddy/repo/owner-scope', () => ({
  ownerScope: vi.fn((userId: string) => ({ userId, scoped: true })),
}));

vi.mock('@/lib/framework/obsiddy/vault/export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/framework/obsiddy/vault/export')>();
  return { ...actual, buildVaultArchive: vi.fn() };
});

vi.mock('@/lib/framework/obsiddy/vault/import', () => ({ importVaultArchive: vi.fn() }));

import { GET as EXPORT_GET } from '@/app/api/v1/obsiddy/vault/export/route';
import { POST as IMPORT_POST } from '@/app/api/v1/obsiddy/vault/import/route';
import { getRouteLogger } from '@/lib/api/context';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { buildVaultArchive, VaultExportError } from '@/lib/framework/obsiddy/vault/export';
import { importVaultArchive } from '@/lib/framework/obsiddy/vault/import';
import { VaultZipError } from '@/lib/framework/obsiddy/vault/zip';

const SESSION = { user: { id: 'user_a' }, session: { userId: 'user_a' } };
const SCOPE = { userId: 'user_a', scoped: true };

function makeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function invoke(handler: unknown, request: unknown): Promise<Response> {
  return (handler as (...args: unknown[]) => Promise<Response>)(request, SESSION);
}

function getRequest(url: string): Request {
  return { url, headers: new Headers() } as unknown as Request;
}

function multipartRequest(
  entries: Record<string, File | string>,
  opts: { contentLength?: string; formDataSpy?: ReturnType<typeof vi.fn> } = {}
): { request: Request; formDataSpy: ReturnType<typeof vi.fn> } {
  const formData = new FormData();
  for (const [key, value] of Object.entries(entries)) formData.set(key, value);

  const headerInit: Record<string, string> = {};
  if (opts.contentLength !== undefined) headerInit['content-length'] = opts.contentLength;

  const formDataSpy = opts.formDataSpy ?? vi.fn(async () => formData);

  return {
    request: {
      url: 'http://localhost/api/v1/obsiddy/vault/import',
      headers: new Headers(headerInit),
      formData: formDataSpy,
    } as unknown as Request,
    formDataSpy,
  };
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function archiveFile(bytes = new Uint8Array([1, 2, 3])): File {
  return new File([bytes], 'vault.zip', { type: 'application/zip' });
}

/** The shape `importVaultArchive` returns, with everything empty by default. */
function importResult(over: Record<string, unknown> = {}) {
  return {
    plan: {
      notes: [],
      creates: 0,
      updates: 0,
      unchanged: 0,
      skipped: [],
      taskUpdates: [],
      mentions: [],
      blankedBodies: [],
    },
    outcome: null,
    ignoredCount: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRouteLogger).mockResolvedValue(makeLog() as never);
  vi.mocked(ownerScope).mockImplementation((userId: string) => ({ userId, scoped: true }) as never);
});

describe('GET /api/v1/obsiddy/vault/export', () => {
  beforeEach(() => {
    vi.mocked(buildVaultArchive).mockResolvedValue({
      bytes: new Uint8Array([80, 75, 3, 4]),
      fileName: 'obsiddy-vault-2026-08-06.zip',
      counts: { area: 2, project: 3, task: 5, goal: 0, entity: 0, thought: 0 },
      generatedAt: new Date('2026-08-06T09:00:00Z'),
    } as never);
  });

  it('returns the archive as a zip with download headers', async () => {
    const response = await invoke(EXPORT_GET, getRequest('http://localhost/x/export'));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/zip');
    expect(response.headers.get('Content-Disposition')).toBe(
      'attachment; filename="obsiddy-vault-2026-08-06.zip"'
    );
    expect(response.headers.get('Content-Length')).toBe('4');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([80, 75, 3, 4]));
  });

  it('forbids a shared cache from holding somebody’s brain', async () => {
    const response = await invoke(EXPORT_GET, getRequest('http://localhost/x/export'));

    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('reports the total note count across every type', async () => {
    const response = await invoke(EXPORT_GET, getRequest('http://localhost/x/export'));

    // 2 + 3 + 5, not the number of types and not just the first one.
    expect(response.headers.get('X-Obsiddy-Note-Count')).toBe('10');
  });

  it('builds the archive against the session owner’s scope only', async () => {
    await invoke(EXPORT_GET, getRequest('http://localhost/x/export'));

    expect(ownerScope).toHaveBeenCalledWith('user_a');
    expect(buildVaultArchive).toHaveBeenCalledWith(SCOPE, { includeArchived: false });
  });

  it('passes includeArchived through when the query asks for it', async () => {
    await invoke(EXPORT_GET, getRequest('http://localhost/x/export?includeArchived=true'));

    expect(buildVaultArchive).toHaveBeenCalledWith(SCOPE, { includeArchived: true });
  });

  it('turns a brain too large for one archive into a 400 with the reason', async () => {
    vi.mocked(buildVaultArchive).mockRejectedValue(
      new VaultExportError('Too many tasks to export', 'too-many')
    );

    const response = await invoke(EXPORT_GET, getRequest('http://localhost/x/export'));

    expect(response.status).toBe(400);
    const payload = await body(response);
    expect(payload.success).toBe(false);
    expect(JSON.stringify(payload)).toContain('too-many');
  });

  it('does not swallow an unexpected failure as a 400', async () => {
    vi.mocked(buildVaultArchive).mockRejectedValue(new Error('connection reset'));

    const response = await invoke(EXPORT_GET, getRequest('http://localhost/x/export'));

    expect(response.status).toBe(500);
  });
});

describe('POST /api/v1/obsiddy/vault/import', () => {
  beforeEach(() => {
    vi.mocked(importVaultArchive).mockResolvedValue(importResult());
  });

  it('plans without applying when the flag is absent, and answers 202', async () => {
    const { request } = multipartRequest({ file: archiveFile() });

    const response = await invoke(IMPORT_POST, request);

    expect(response.status).toBe(202);
    const payload = await body(response);
    expect((payload.data as Record<string, unknown>).applied).toBe(false);
    expect(importVaultArchive).toHaveBeenCalledWith(SCOPE, expect.any(Uint8Array), {
      apply: false,
      allowBlanking: false,
    });
  });

  it('applies and answers 200 when the flag is explicitly set', async () => {
    vi.mocked(importVaultArchive).mockResolvedValue(
      importResult({
        outcome: { created: 4, updated: 1, tasksTicked: 0, linksProposed: 0, failed: [] },
      })
    );
    const { request } = multipartRequest({ file: archiveFile(), apply: 'true' });

    const response = await invoke(IMPORT_POST, request);

    expect(response.status).toBe(200);
    const payload = await body(response);
    expect((payload.data as Record<string, unknown>).applied).toBe(true);
    expect(importVaultArchive).toHaveBeenCalledWith(
      SCOPE,
      expect.any(Uint8Array),
      expect.objectContaining({ apply: true })
    );
  });

  it('refuses a malformed flag outright rather than guessing at it', async () => {
    const { request } = multipartRequest({ file: archiveFile(), apply: 'yes please' });

    const response = await invoke(IMPORT_POST, request);

    // The schema is a closed enum, so an unrecognised value is a 400 — not a
    // silent dry run, and emphatically not a silent apply. Either guess would be
    // a write decision made on the user's behalf.
    expect(response.status).toBe(400);
    expect(importVaultArchive).not.toHaveBeenCalled();
  });

  it('ignores a form field it does not know, and stays a dry run', async () => {
    // The route reads exactly the two keys it understands out of the form, so a
    // stray `force=true` never reaches the schema. What matters is that an
    // unrecognised field cannot become a write: the run stays a plan.
    const { request } = multipartRequest({ file: archiveFile(), force: 'true' });

    const response = await invoke(IMPORT_POST, request);

    expect(response.status).toBe(202);
    expect(importVaultArchive).toHaveBeenCalledWith(SCOPE, expect.any(Uint8Array), {
      apply: false,
      allowBlanking: false,
    });
  });

  it('keeps allowBlanking off unless it is asked for', async () => {
    const { request } = multipartRequest({ file: archiveFile(), apply: 'true' });

    await invoke(IMPORT_POST, request);

    expect(importVaultArchive).toHaveBeenCalledWith(
      SCOPE,
      expect.any(Uint8Array),
      expect.objectContaining({ allowBlanking: false })
    );
  });

  it('passes allowBlanking through when the user ticked the box', async () => {
    const { request } = multipartRequest({
      file: archiveFile(),
      apply: 'true',
      allowBlanking: 'true',
    });

    await invoke(IMPORT_POST, request);

    expect(importVaultArchive).toHaveBeenCalledWith(
      SCOPE,
      expect.any(Uint8Array),
      expect.objectContaining({ allowBlanking: true })
    );
  });

  it('rejects an oversized archive BEFORE reading the body into memory', async () => {
    const formDataSpy = vi.fn(async () => new FormData());
    const { request } = multipartRequest(
      {},
      { contentLength: String(60 * 1024 * 1024), formDataSpy }
    );

    const response = await invoke(IMPORT_POST, request);

    expect(response.status).toBe(413);
    // The whole point of the guard order — formData() materialises the body.
    expect(formDataSpy).not.toHaveBeenCalled();
    expect(importVaultArchive).not.toHaveBeenCalled();
  });

  it('rejects a request with no file field', async () => {
    const { request } = multipartRequest({ apply: 'true' });

    const response = await invoke(IMPORT_POST, request);

    expect(response.status).toBe(400);
    expect(importVaultArchive).not.toHaveBeenCalled();
  });

  it('turns a refused archive into a 400 carrying the specific reason', async () => {
    vi.mocked(importVaultArchive).mockRejectedValue(
      new VaultZipError('"big.md" expands more than 100× and was refused', 'compression-ratio')
    );
    const { request } = multipartRequest({ file: archiveFile() });

    const response = await invoke(IMPORT_POST, request);

    expect(response.status).toBe(400);
    expect(JSON.stringify(await body(response))).toContain('compression-ratio');
  });

  it('does not turn an unexpected failure into a 400', async () => {
    vi.mocked(importVaultArchive).mockRejectedValue(new Error('connection reset'));
    const { request } = multipartRequest({ file: archiveFile() });

    const response = await invoke(IMPORT_POST, request);

    expect(response.status).toBe(500);
  });

  it('reports an id from somebody else’s vault rather than hiding it', async () => {
    vi.mocked(importVaultArchive).mockResolvedValue(
      importResult({
        plan: {
          ...importResult().plan,
          creates: 1,
          notes: [
            {
              path: 'Tasks/stolen.md',
              type: 'task',
              targetId: null,
              title: 'Not yours',
              changedKeys: [],
              bodyChanged: false,
              issues: [],
              claimedForeignId: 'task_someone_else',
            },
          ],
        },
      })
    );
    const { request } = multipartRequest({ file: archiveFile() });

    const response = await invoke(IMPORT_POST, request);

    const notes = (await body(response)).data as { notes: Array<Record<string, unknown>> };
    expect(notes.notes[0]).toMatchObject({
      action: 'create',
      unknownId: 'task_someone_else',
    });
  });

  it('does not echo note bodies back in the plan', async () => {
    vi.mocked(importVaultArchive).mockResolvedValue(
      importResult({
        plan: {
          ...importResult().plan,
          notes: [
            {
              path: 'Tasks/a.md',
              type: 'task',
              targetId: 'task_1',
              title: 'A',
              body: 'a very long body that must not come back',
              fields: { title: 'A' },
              changedKeys: ['title'],
              bodyChanged: true,
              issues: [],
              claimedForeignId: null,
            },
          ],
        },
      })
    );
    const { request } = multipartRequest({ file: archiveFile() });

    const response = await invoke(IMPORT_POST, request);

    const raw = JSON.stringify(await body(response));
    // The plan is a diff summary, not a second copy of the archive.
    expect(raw).not.toContain('a very long body');
    expect(raw).toContain('"action":"update"');
  });

  it('calls an update with nothing to change unchanged', async () => {
    vi.mocked(importVaultArchive).mockResolvedValue(
      importResult({
        plan: {
          ...importResult().plan,
          notes: [
            {
              path: 'Tasks/a.md',
              type: 'task',
              targetId: 'task_1',
              title: 'A',
              changedKeys: [],
              bodyChanged: false,
              issues: [],
              claimedForeignId: null,
            },
          ],
        },
      })
    );
    const { request } = multipartRequest({ file: archiveFile() });

    const response = await invoke(IMPORT_POST, request);

    const data = (await body(response)).data as { notes: Array<Record<string, unknown>> };
    expect(data.notes[0]?.action).toBe('unchanged');
  });

  it('imports against the session owner’s scope only', async () => {
    const { request } = multipartRequest({ file: archiveFile() });

    await invoke(IMPORT_POST, request);

    expect(ownerScope).toHaveBeenCalledWith('user_a');
    expect(vi.mocked(importVaultArchive).mock.calls[0]?.[0]).toEqual(SCOPE);
  });
});

describe('POST /api/v1/obsiddy/vault/import — the export cap is reachable here too', () => {
  it('answers 400 with the reason when the brain is past the export ceiling', async () => {
    // Import builds its identity index by reading the whole brain, so the same
    // per-type ceiling the export route enforces can fire on this path. Caught
    // only VaultZipError, it surfaced as a bare 500 on the one route whose
    // sibling says exactly what is wrong.
    vi.mocked(importVaultArchive).mockRejectedValue(
      new VaultExportError('This brain holds more than 10,000 task records', 'too-many-records')
    );
    const { request } = multipartRequest({ file: archiveFile() });

    const response = await invoke(IMPORT_POST, request);

    expect(response.status).toBe(400);
    expect(JSON.stringify(await body(response))).toContain('too-many-records');
  });
});
