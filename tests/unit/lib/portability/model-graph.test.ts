/**
 * Freshness guard: the generated model graph vs the schema on disk.
 *
 * `lib/portability/model-graph.generated.ts` is rebuilt by every `prisma
 * generate`, which is already both `postinstall` and `npm run db:generate`. That
 * makes it hard to go stale, not impossible — a schema edit followed by
 * `prisma migrate dev` alone leaves the graph describing a datamodel that no
 * longer exists, and every downstream guard then checks the old shape and passes.
 *
 * This catches that locally, in watch mode, seconds after the edit. CI's
 * `prisma generate && git diff --exit-code` is the second line, and it also
 * catches the case this one cannot: somebody hand-editing the generated file.
 *
 * ---------------------------------------------------------------------------
 * IF THIS TEST IS FAILING
 * ---------------------------------------------------------------------------
 * Run `npm run db:generate` and commit the regenerated file.
 *
 * @see prisma/generators/portability.mjs
 */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { fingerprintSchema, schemaFiles } from '@/prisma/generators/schema-fingerprint.mjs';

import {
  MODEL_GRAPH,
  MODEL_NAMES,
  SCHEMA_FINGERPRINT,
} from '@/lib/portability/model-graph.generated';

const SCHEMA_DIR = path.join(process.cwd(), 'prisma', 'schema');

describe('freshness', () => {
  it('reads the schema files it is meant to', () => {
    // Guard on the guard: a fingerprint over an empty file list is a constant,
    // and would match itself for ever.
    const files = schemaFiles(SCHEMA_DIR);
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((f) => f.endsWith('framework-resparkable.prisma'))).toBe(true);
  });

  it('matches the schema currently on disk', () => {
    expect(
      fingerprintSchema(SCHEMA_DIR),
      'The generated model graph is stale. Run `npm run db:generate` and commit the result.'
    ).toBe(SCHEMA_FINGERPRINT);
  });
});

describe('shape', () => {
  it('describes every model exactly once, in sorted order', () => {
    expect(MODEL_NAMES.length).toBe(new Set(MODEL_NAMES).size);
    expect([...MODEL_NAMES]).toEqual([...MODEL_NAMES].sort());
  });

  it('gives every model a delegate and a primary key', () => {
    for (const name of MODEL_NAMES) {
      const node = MODEL_GRAPH[name];
      expect(node.delegate, `${name} has no delegate`).toBeTruthy();
      expect(node.idFields.length, `${name} has no primary key`).toBeGreaterThan(0);
    }
  });

  it('records outgoing foreign keys only', () => {
    // A back-relation names no columns. If one leaked in, the topological sort
    // would see a cycle everywhere a parent lists its children.
    for (const name of MODEL_NAMES) {
      for (const edge of MODEL_GRAPH[name].relations) {
        expect(edge.fromFields.length, `${name} has an edge with no FK columns`).toBeGreaterThan(0);
        expect(
          MODEL_GRAPH[edge.toModel],
          `${name} points at unknown model ${edge.toModel}`
        ).toBeDefined();
      }
    }
  });

  it('distinguishes an id-remapping edge from an owner-column edge', () => {
    // Every brain table's `space` relation points at `ResparkableSpace.userId`,
    // not at its primary key. It is a real ordering dependency — the space row
    // must exist first — but the value comes from the session, not from the
    // id-map. The engine tells the two apart by comparing `toFields` against the
    // target's `idFields`, so that distinction has to hold in the data.
    const spaceEdge = MODEL_GRAPH.ResparkableGoal.relations.find(
      (r) => r.toModel === 'ResparkableSpace'
    );
    expect(spaceEdge?.toFields).toEqual(['userId']);
    expect(MODEL_GRAPH.ResparkableSpace.idFields).toEqual(['id']);

    const areaEdge = MODEL_GRAPH.ResparkableGoal.relations.find(
      (r) => r.toModel === 'ResparkableArea'
    );
    expect(areaEdge?.toFields).toEqual(MODEL_GRAPH.ResparkableArea.idFields);
  });

  it('marks the self-referential edge that needs a second pass', () => {
    const parent = MODEL_GRAPH.ResparkableGoal.relations.find((r) => r.isSelfReference);
    expect(parent?.fromFields).toEqual(['parentGoalId']);
    expect(parent?.optional).toBe(true);
  });

  it('carries the length limits the import path clamps to', () => {
    const horizon = MODEL_GRAPH.ResparkableGoal.fields.find((f) => f.name === 'horizon');
    expect(horizon?.maxLength).toBe(16);
  });
});
