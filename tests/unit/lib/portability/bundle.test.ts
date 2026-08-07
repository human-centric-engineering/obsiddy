/**
 * Unit tests for lib/portability/bundle.ts
 *
 * Contract under test:
 *   buildTransferBundle(collected, generatedAt)
 *   1. one JSON file per non-empty table, none for an empty one
 *   2. a manifest that accounts for every table, including the ones with no file
 *   3. omissions stated: redacted columns, unreadable columns, excluded tables
 *   4. a README a person can read without the app
 *   5. values that JSON cannot represent survive the trip
 *
 * The assertions that matter here are about **what the bundle says about
 * itself**. A missing table looks exactly like an empty one in a file listing,
 * and a redacted column looks exactly like a column that was always null — so
 * the manifest is the only thing standing between a designed omission and an
 * undetectable bug.
 *
 * @see lib/portability/bundle.ts
 */

import { describe, expect, it } from 'vitest';

import {
  BUNDLE_MANIFEST_PATH,
  BUNDLE_README_PATH,
  buildTransferBundle,
  bundleFileName,
  TRANSFER_BUNDLE_VERSION,
} from '@/lib/portability/bundle';
import type { CollectedAccount, CollectedModel } from '@/lib/portability/collect';
import { SCHEMA_FINGERPRINT } from '@/lib/portability/model-graph.generated';

const AT = new Date('2026-08-07T09:30:00.000Z');

function model(overrides: Partial<CollectedModel> & Pick<CollectedModel, 'model'>): CollectedModel {
  return {
    group: 'conversations',
    disposition: 'transfer',
    note: 'A thing you own.',
    strategy: 'owner',
    rows: [],
    redacted: [],
    unsupported: [],
    ...overrides,
  };
}

function collected(overrides: Partial<CollectedAccount> = {}): CollectedAccount {
  return {
    userId: 'user-1',
    groups: ['conversations'],
    models: [],
    unreachable: [],
    totalRows: 0,
    ...overrides,
  };
}

describe('buildTransferBundle', () => {
  describe('file layout', () => {
    it('writes one JSON file per table that has rows', () => {
      const bundle = buildTransferBundle(
        collected({
          models: [model({ model: 'AiConversation', rows: [{ id: 'c1' }, { id: 'c2' }] })],
          totalRows: 2,
        }),
        AT
      );

      expect(Object.keys(bundle.files)).toContain('data/AiConversation.json');
      expect(JSON.parse(bundle.files['data/AiConversation.json'])).toEqual([
        { id: 'c1' },
        { id: 'c2' },
      ]);
    });

    it('writes no file for an empty table, but still names it in the manifest', () => {
      // The manifest line is the point: it records that the table was looked at,
      // which an absent file cannot say and an empty file would only repeat.
      const bundle = buildTransferBundle(
        collected({ models: [model({ model: 'AiMessage', rows: [] })] }),
        AT
      );

      expect(Object.keys(bundle.files)).not.toContain('data/AiMessage.json');
      expect(bundle.manifest.models).toContainEqual(
        expect.objectContaining({ model: 'AiMessage', rows: 0, file: null })
      );
    });

    it('always includes the manifest and the readme', () => {
      const bundle = buildTransferBundle(collected(), AT);

      expect(Object.keys(bundle.files).sort()).toEqual(
        [BUNDLE_MANIFEST_PATH, BUNDLE_README_PATH].sort()
      );
    });

    it('points each manifest entry at the file it actually wrote', () => {
      const bundle = buildTransferBundle(
        collected({ models: [model({ model: 'AiConversation', rows: [{ id: 'c1' }] })] }),
        AT
      );

      const entry = bundle.manifest.models.find((e) => e.model === 'AiConversation');
      expect(entry?.file).toBe('data/AiConversation.json');
      expect(bundle.files[entry!.file!]).toBeDefined();
    });
  });

  describe('the manifest', () => {
    it('stamps the format version and the schema it came from', () => {
      const bundle = buildTransferBundle(collected(), AT);

      expect(bundle.manifest.formatVersion).toBe(TRANSFER_BUNDLE_VERSION);
      expect(bundle.manifest.schemaFingerprint).toBe(SCHEMA_FINGERPRINT);
      expect(bundle.manifest.generatedAt).toBe('2026-08-07T09:30:00.000Z');
    });

    it('records which columns were dropped, and which will be reissued', () => {
      const bundle = buildTransferBundle(
        collected({
          models: [
            model({
              model: 'ResparkableSpace',
              group: 'brain',
              rows: [{ userId: 'user-1' }],
              redacted: ['inboxToken'],
            }),
          ],
        }),
        AT
      );

      const entry = bundle.manifest.models.find((e) => e.model === 'ResparkableSpace');
      expect(entry?.redacted).toEqual(['inboxToken']);
    });

    it('reads regenerate straight off the live policy rather than a second copy', () => {
      const bundle = buildTransferBundle(
        collected({ models: [model({ model: 'User', group: 'account', rows: [{ id: 'u' }] })] }),
        AT
      );

      const entry = bundle.manifest.models.find((e) => e.model === 'User');
      expect(entry?.regenerate).toContain('email');
      expect(entry?.regenerate).toContain('role');
    });

    it('carries the reason for every table it could not reach', () => {
      const bundle = buildTransferBundle(
        collected({
          unreachable: [
            { model: 'McpServerConfig', group: 'automation', reason: 'Installation-wide config.' },
          ],
        }),
        AT
      );

      expect(bundle.manifest.unreachable).toEqual([
        { model: 'McpServerConfig', group: 'automation', reason: 'Installation-wide config.' },
      ]);
    });

    it('lists the tables that never leave, from the live manifest', () => {
      const bundle = buildTransferBundle(collected(), AT);

      expect(bundle.manifest.excluded.length).toBeGreaterThan(0);
      for (const entry of bundle.manifest.excluded) {
        expect(entry.reason.length).toBeGreaterThan(20);
      }
    });
  });

  describe('serialisation', () => {
    it('turns dates into ISO strings rather than dropping them', () => {
      const bundle = buildTransferBundle(
        collected({
          models: [
            model({
              model: 'AiConversation',
              rows: [{ createdAt: new Date('2026-01-02T03:04:05Z') }],
            }),
          ],
        }),
        AT
      );

      expect(JSON.parse(bundle.files['data/AiConversation.json'])).toEqual([
        { createdAt: '2026-01-02T03:04:05.000Z' },
      ]);
    });

    it('survives a BigInt, which plain JSON.stringify throws on', () => {
      // No column is BigInt today. A fork adding one must not discover it as a
      // TypeError thrown halfway through somebody's download.
      const bundle = buildTransferBundle(
        collected({ models: [model({ model: 'AiConversation', rows: [{ n: 10n }] })] }),
        AT
      );

      expect(JSON.parse(bundle.files['data/AiConversation.json'])).toEqual([{ n: '10' }]);
    });

    it('base64-encodes bytes rather than writing them as an object of indexes', () => {
      const bundle = buildTransferBundle(
        collected({
          models: [model({ model: 'AiConversation', rows: [{ blob: new Uint8Array([1, 2, 3]) }] })],
        }),
        AT
      );

      expect(JSON.parse(bundle.files['data/AiConversation.json'])).toEqual([{ blob: 'AQID' }]);
    });
  });

  describe('the readme', () => {
    it('names each table in plain English with its record count', () => {
      const bundle = buildTransferBundle(
        collected({
          models: [
            model({
              model: 'AiConversation',
              note: 'Your chat conversations with agents.',
              rows: [{ id: 'c1' }, { id: 'c2' }],
            }),
          ],
          totalRows: 2,
        }),
        AT
      );

      const readme = bundle.files[BUNDLE_README_PATH];
      expect(readme).toContain('Your chat conversations with agents.');
      expect(readme).toContain('2 records');
      expect(readme).toContain('Conversations');
    });

    it('says what was left out and why', () => {
      const bundle = buildTransferBundle(
        collected({
          models: [
            model({
              model: 'ResparkableSpace',
              group: 'brain',
              rows: [{ userId: 'u' }],
              redacted: ['inboxToken'],
              unsupported: ['searchVector'],
            }),
          ],
          unreachable: [
            { model: 'McpServerConfig', group: 'automation', reason: 'Installation-wide config.' },
          ],
          groups: ['brain'],
        }),
        AT
      );

      const readme = bundle.files[BUNDLE_README_PATH];
      expect(readme).toContain('inboxToken');
      expect(readme).toContain('searchVector');
      expect(readme).toContain('Installation-wide config.');
    });

    it('tells the reader they do not need the app to open it', () => {
      const bundle = buildTransferBundle(collected(), AT);

      expect(bundle.files[BUNDLE_README_PATH]).toContain('ordinary JSON');
    });
  });

  describe('bundleFileName', () => {
    it('carries a date and nothing else identifying', () => {
      expect(bundleFileName(AT)).toBe('account-export-2026-08-07.zip');
    });
  });
});
