/**
 * Coverage guard: the Obsiddy subject-access export vs framework-obsiddy.prisma.
 *
 * This is the fork-side twin of core's `export-sources.test.ts`, and
 * `lib/app/data-export.ts` asks for it by name: *"Your tables need the same
 * protection, and core cannot write it for you — the pattern worth copying is a
 * constant listing the tables you export plus a test that greps your own schema
 * file."*
 *
 * The failure it exists to prevent is the quiet one. Adding a table to the brain
 * and forgetting this file does not break anything a user or a test would
 * notice; it just means the next subject-access request is answered with a
 * bundle that looks complete and silently omits whatever the new table held.
 * Nobody can tell from the outside — not the subject, not the operator. So the
 * guard reads the schema rather than trusting the manifest to be current.
 *
 * Test Coverage:
 * - Every model carrying a `userId` is exported or excluded with a reason
 * - The manifest names only models that actually exist (catches a rename)
 * - No model is both exported and excluded
 * - Exclusion reasons are substantive, not a shrug
 * - Section names are unique, so one table cannot overwrite another's data
 * - The schema scan actually finds tables (guard on the guard)
 *
 * The runtime half — that every query is owner-scoped and the inbox token is
 * omitted — is in `subject-export-behaviour.test.ts`.
 *
 * @see lib/framework/obsiddy/repo/subject-export.ts
 * @see lib/app/data-export.ts
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  OBSIDDY_SUBJECT_SOURCES,
  OBSIDDY_EXCLUDED_MODELS,
  OBSIDDY_EXPORT_SECTIONS,
} from '@/lib/framework/obsiddy/repo/subject-export';

const SCHEMA_PATH = path.join(process.cwd(), 'prisma/schema/framework-obsiddy.prisma');

const MODEL_OPEN = /^model\s+(\w+)\s*\{/;
/** A plain column holding the owner's id. Every scoped Obsiddy table has one. */
const USER_SCALAR_FIELD = /^\s*userId\s+String/;

/** Models in the tier's schema that carry a `userId`, read from the file itself. */
function scanScopedModels(): Set<string> {
  const source = readFileSync(SCHEMA_PATH, 'utf8');
  const scoped = new Set<string>();
  let current: string | null = null;

  for (const line of source.split('\n')) {
    const opened = MODEL_OPEN.exec(line);
    if (opened) {
      current = opened[1]!;
      continue;
    }
    if (line.startsWith('}')) {
      current = null;
      continue;
    }
    if (current && USER_SCALAR_FIELD.test(line)) scoped.add(current);
  }

  return scoped;
}

/** Every model name in the tier's schema, for rename/typo detection. */
function scanAllModels(): Set<string> {
  const source = readFileSync(SCHEMA_PATH, 'utf8');
  return new Set(
    source
      .split('\n')
      .map((line) => MODEL_OPEN.exec(line)?.[1])
      .filter((name): name is string => Boolean(name))
  );
}

const scoped = scanScopedModels();
const allModels = scanAllModels();
const exported = new Set(Object.keys(OBSIDDY_SUBJECT_SOURCES));
const excluded = new Set(OBSIDDY_EXCLUDED_MODELS.map((entry) => entry.model));

describe('the schema scan itself', () => {
  it('finds the scoped tables it is meant to find', () => {
    // Guard on the guard: if the regex stops matching, every check below passes
    // while protecting nothing.
    expect(scoped.size).toBeGreaterThanOrEqual(15);
    expect(scoped.has('ObsiddyThought')).toBe(true);
    expect(scoped.has('ObsiddyTask')).toBe(true);
  });

  it('does not treat the operator singleton as scoped', () => {
    // `ObsiddySettings` is keyed by `slug` and holds no `userId`, so it is not a
    // subject's data and must not be demanded of the manifest.
    expect(allModels.has('ObsiddySettings')).toBe(true);
    expect(scoped.has('ObsiddySettings')).toBe(false);
  });
});

describe('coverage', () => {
  it('exports or excludes every table holding a user id', () => {
    const missing = [...scoped].filter((model) => !exported.has(model) && !excluded.has(model));

    expect(
      missing.sort(),
      missing.length === 0
        ? ''
        : `These Obsiddy tables hold data about a person but appear in neither ` +
            `OBSIDDY_SUBJECT_SOURCES nor OBSIDDY_EXCLUDED_MODELS, so a subject-access ` +
            `export silently omits them: ${missing.join(', ')}. Add each to the ` +
            `manifest, or exclude it with a written reason. ` +
            `See lib/framework/obsiddy/repo/subject-export.ts.`
    ).toEqual([]);
  });

  it('names only models that exist', () => {
    // A rename would otherwise leave a source querying nothing and reporting an
    // empty section for ever — which reads as "you have no tasks", not as a bug.
    const unknown = [...exported, ...excluded].filter((model) => !allModels.has(model));

    expect(unknown.sort()).toEqual([]);
  });

  it('never both exports and excludes a model', () => {
    const both = [...exported].filter((model) => excluded.has(model));

    expect(both).toEqual([]);
  });
});

describe('exclusions', () => {
  it('carry a substantive reason', () => {
    // A one-word reason is how a table nobody wanted to think about ends up
    // excluded. The bar is deliberately the same as core's.
    const unexplained = OBSIDDY_EXCLUDED_MODELS.filter(
      (entry) => entry.reason.trim().length < 20
    ).map((entry) => entry.model);

    expect(unexplained).toEqual([]);
  });

  it('excludes the derived-vector table and nothing else', () => {
    // Kept tight on purpose: the moment "excluded" becomes a habit, the export
    // starts shrinking without anyone deciding that it should.
    expect([...excluded]).toEqual(['ObsiddyEmbedding']);
  });
});

describe('sections', () => {
  it('are unique, so no table can overwrite another’s data', () => {
    // Two sources sharing a section name would silently drop one of them — the
    // bundle would still look well-formed.
    expect(new Set(OBSIDDY_EXPORT_SECTIONS).size).toBe(OBSIDDY_EXPORT_SECTIONS.length);
  });

  it('cover the free-text tables a reader would look for first', () => {
    // The sections whose absence would make the export obviously worthless.
    for (const section of ['thoughts', 'tasks', 'documents', 'people', 'reviews']) {
      expect(OBSIDDY_EXPORT_SECTIONS).toContain(section);
    }
  });
});
