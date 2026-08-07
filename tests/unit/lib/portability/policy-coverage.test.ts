/**
 * Coverage guard: the transfer policy vs the generated model graph.
 *
 * Account transfer is denylist-driven — a new *column* joins the bundle by
 * default, exactly as the Art. 15 manifest intends with Prisma `omit`. That is
 * right for columns and dangerous for two other things, which is what this file
 * exists to catch:
 *
 *   • A new **model**, auto-included, would ship data nobody reviewed on the way
 *     out and write rows nobody reviewed on the way in.
 *   • A new **secret-shaped column**, auto-included, would put credential
 *     material in a file that gets emailed, synced and forgotten.
 *
 * Both fail here instead.
 *
 * ---------------------------------------------------------------------------
 * IF THIS TEST IS FAILING
 * ---------------------------------------------------------------------------
 * Read the failure message — it names the file to edit. In short:
 *
 *   • core / orchestration model  → `lib/portability/core-policies.ts`
 *   • `Resparkable*` model        → `lib/framework/resparkable/transfer/policy.ts`
 *   • model in `app.prisma`       → `lib/app/data-transfer.ts`
 *
 * Give it a `disposition`:
 *
 *   • `transfer`    — it moves, and is written back on import.
 *   • `export-only` — it goes in the bundle for the record, never written back.
 *   • `skip`        — it never leaves. Say why, in a sentence someone else can
 *                     evaluate.
 *
 * Do not delete an entry to make this pass. An export missing a table looks
 * exactly like a complete one to the person reading it.
 *
 * @see lib/portability/policy.ts
 * @see .context/framework/resparkable/transfer.md
 */

import { describe, expect, it } from 'vitest';

import { MODEL_GRAPH, MODEL_NAMES } from '@/lib/portability/model-graph.generated';
import type { TransferPolicy } from '@/lib/portability/policy';
import {
  CROSS_BOUNDARY_EDGES,
  TRANSFER_EXCLUDED,
  TRANSFER_POLICIES,
  policyFor,
} from '@/lib/portability/registry';

/**
 * Column names that might be credential material.
 *
 * Deliberately over-broad. Every false positive costs one line of
 * `secretReviewed` prose; a false negative ships a secret. The exceptions being
 * visible in the policy is the point — it means a genuinely new secret cannot
 * arrive behind a name that already looked familiar.
 */
const SECRETISH =
  /token|secret|key|password|passwd|hash|credential|salt|signature|nonce|otp|private/i;

/**
 * Whether a column could plausibly *hold* a secret, as opposed to merely being
 * named like one.
 *
 * The pattern above matches 53 columns; roughly forty of them are token
 * *counts* (`maxTokens`, `inputTokens`, `costPerMillionTokens`), expiry
 * timestamps, or rate limits. Requiring a written exemption for each would mean
 * forty rubber-stamped lines, and a guard that people rubber-stamp is a guard
 * that stops being read — which is the specific failure this exists to prevent.
 *
 * Narrowing by *type* rather than by name keeps the name pattern deliberately
 * broad while cutting the noise: credential material is a string. An `Int` named
 * `maxTokens` cannot be an API key no matter what it is called.
 *
 * `Json` columns are excluded here because they are not unexamined — every one
 * has to be declared in `jsonRefs` or `jsonOpaque` with a reason, which is a
 * stricter requirement than this test imposes.
 */
function couldHoldASecret(field: { name: string; type: string }): boolean {
  return field.type === 'String' && SECRETISH.test(field.name);
}

const excludedByModel = new Map(TRANSFER_EXCLUDED.map((entry) => [entry.model, entry]));

/**
 * Which file a reader should edit, from the schema file the model lives in.
 *
 * Routed on the source file rather than a name prefix, because a fork's models
 * are called whatever the fork calls them — the only reliable signal is which
 * `.prisma` they were declared in.
 */
function homeFor(model: string): string {
  switch (MODEL_GRAPH[model]?.sourceFile) {
    case 'app.prisma':
      return 'lib/app/data-transfer.ts';
    case 'framework-resparkable.prisma':
      return 'lib/framework/resparkable/transfer/policy.ts';
    default:
      return 'lib/portability/core-policies.ts';
  }
}

const transferable = TRANSFER_POLICIES.filter((p) => p.disposition === 'transfer');
const inBundle = TRANSFER_POLICIES.filter((p) => p.disposition !== 'skip');

describe('guard on the guard', () => {
  // Without these, every assertion below can pass by reading nothing at all.
  it('reads a model graph that is actually populated', () => {
    expect(MODEL_NAMES.length).toBeGreaterThan(70);
    expect(MODEL_GRAPH.User).toBeDefined();
    expect(MODEL_GRAPH.ResparkableTask).toBeDefined();
  });

  it('sees real foreign keys', () => {
    const targets = MODEL_GRAPH.ResparkableTask.relations.map((r) => r.toModel);
    expect(targets).toContain('ResparkableProject');
    expect(targets).toContain('ResparkableSpace');
  });

  it('sees the soft references the schema hides from the database', () => {
    expect(MODEL_GRAPH.ResparkableLink.suspectedSoftRefs).toEqual(
      expect.arrayContaining(['sourceId', 'targetId'])
    );
    expect(MODEL_GRAPH.ResparkableThought.suspectedSoftRefs).toContain('promotedToId');
    expect(MODEL_GRAPH.ResparkableReview.suspectedSoftRefs).toContain('workflowExecutionId');
  });

  it('sees the Unsupported columns Prisma omits from its own datamodel', () => {
    expect(MODEL_GRAPH.ResparkableEmbedding.unsupported).toContain('embedding');
    expect(MODEL_GRAPH.ResparkableTask.unsupported).toContain('searchVector');
  });

  it('still recognises a known secret, and still ignores what cannot be one', () => {
    // If the pattern is ever loosened into uselessness, this fails first.
    expect(couldHoldASecret({ name: 'token', type: 'String' })).toBe(true);
    expect(couldHoldASecret({ name: 'keyHash', type: 'String' })).toBe(true);
    expect(couldHoldASecret({ name: 'inboxToken', type: 'String' })).toBe(true);
    expect(couldHoldASecret({ name: 'signingSecret', type: 'String' })).toBe(true);
    expect(couldHoldASecret({ name: 'title', type: 'String' })).toBe(false);
    // The type narrowing must not swallow a real one.
    expect(couldHoldASecret({ name: 'maxTokens', type: 'Int' })).toBe(false);
  });

  it('catches a real secret on a model that leaves', () => {
    // The end-to-end proof that the guard would bite: this column exists, is a
    // String, matches the pattern, and lives on a model that is in the bundle —
    // so the only reason it passes is the explicit `regenerate` declaration.
    const space = MODEL_GRAPH.ResparkableSpace.fields.find((f) => f.name === 'inboxToken');
    expect(space && couldHoldASecret(space)).toBe(true);
    expect(policyFor('ResparkableSpace')?.regenerate).toContain('inboxToken');
  });

  it('has policies to check', () => {
    expect(TRANSFER_POLICIES.length).toBeGreaterThan(50);
    expect(transferable.length).toBeGreaterThan(20);
  });
});

describe('coverage', () => {
  it('classifies every model in the schema', () => {
    const unclassified = MODEL_NAMES.filter(
      (model) => !policyFor(model) && !excludedByModel.has(model)
    );

    expect(
      unclassified,
      unclassified.length === 0
        ? ''
        : `Unclassified model(s): ${unclassified.join(', ')}. ` +
            `Add each to ${homeFor(unclassified[0])} with a disposition, or to that ` +
            `file's \`excluded\` list with a reason.`
    ).toEqual([]);
  });

  it('names only models that exist', () => {
    const declared = [
      ...TRANSFER_POLICIES.map((p) => p.model),
      ...TRANSFER_EXCLUDED.map((e) => e.model),
    ];
    const ghosts = declared.filter((model) => !MODEL_GRAPH[model]);

    expect(ghosts, `Policy names model(s) not in the schema: ${ghosts.join(', ')}`).toEqual([]);
  });

  it('classifies each model exactly once', () => {
    const seen = new Map<string, number>();
    for (const model of [
      ...TRANSFER_POLICIES.map((p) => p.model),
      ...TRANSFER_EXCLUDED.map((e) => e.model),
    ]) {
      seen.set(model, (seen.get(model) ?? 0) + 1);
    }
    const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([model]) => model);

    expect(duplicates, `Declared more than once: ${duplicates.join(', ')}`).toEqual([]);
  });

  it('gives every exclusion a substantive reason', () => {
    for (const entry of TRANSFER_EXCLUDED) {
      expect(
        entry.reason.trim().length,
        `${entry.model}'s exclusion reason is too short`
      ).toBeGreaterThan(40);
    }
  });

  it('gives every policy a note a user could read', () => {
    for (const policy of TRANSFER_POLICIES) {
      expect(policy.note.trim().length, `${policy.model} has no usable note`).toBeGreaterThan(20);
    }
  });
});

describe('ownership', () => {
  it('names an owner column that exists and is a required String', () => {
    for (const policy of TRANSFER_POLICIES) {
      if (!policy.ownerColumn) continue;
      const field = MODEL_GRAPH[policy.model].fields.find((f) => f.name === policy.ownerColumn);

      expect(field, `${policy.model}.${policy.ownerColumn} does not exist`).toBeDefined();
      expect(field?.type, `${policy.model}.${policy.ownerColumn} must be a String`).toBe('String');
    }
  });

  it('can reach every transferable model from an owner', () => {
    // A model with no owner column must be reachable through a required foreign
    // key to something that is transferable — otherwise the export has no way to
    // scope it to one person and would read the whole table.
    const transferableNames = new Set(transferable.map((p) => p.model));

    for (const policy of transferable) {
      if (policy.ownerColumn) continue;

      const parents = MODEL_GRAPH[policy.model].relations
        .filter((r) => !r.optional)
        .map((r) => r.toModel)
        .filter((target) => transferableNames.has(target));

      expect(
        parents.length,
        `${policy.model} has no ownerColumn and no required FK to a transferable model, ` +
          `so an export cannot scope it to one user. Give it an ownerColumn, or make it export-only.`
      ).toBeGreaterThan(0);
    }
  });
});

describe('column classification', () => {
  const columnNames = (model: string) => new Set(MODEL_GRAPH[model].fields.map((f) => f.name));

  it('only names columns that exist', () => {
    for (const policy of TRANSFER_POLICIES) {
      const columns = columnNames(policy.model);
      const named: Array<[string, string]> = [
        ...(policy.redact ?? []).map((c): [string, string] => [c, 'redact']),
        ...(policy.regenerate ?? []).map((c): [string, string] => [c, 'regenerate']),
        ...Object.keys(policy.reset ?? {}).map((c): [string, string] => [c, 'reset']),
        ...Object.keys(policy.jsonOpaque ?? {}).map((c): [string, string] => [c, 'jsonOpaque']),
        ...Object.keys(policy.softRefsIgnored ?? {}).map((c): [string, string] => [
          c,
          'softRefsIgnored',
        ]),
        ...Object.keys(policy.secretReviewed ?? {}).map((c): [string, string] => [
          c,
          'secretReviewed',
        ]),
        ...(policy.softRefs ?? []).map((r): [string, string] => [r.idColumn, 'softRefs']),
        ...(policy.jsonRefs ?? []).map((r): [string, string] => [r.column, 'jsonRefs']),
      ];

      for (const [column, where] of named) {
        expect(
          columns.has(column),
          `${policy.model}.${column} named in \`${where}\` does not exist`
        ).toBe(true);
      }
    }
  });

  it('never names an Unsupported column in a write list', () => {
    // A model may transfer *and* carry Unsupported columns — `ResparkableTask`
    // does. Its `searchVector` is `GENERATED ALWAYS AS … STORED`, so Postgres
    // fills it on insert and no writer should ever mention it. What must not
    // happen is a policy claiming to write, reset or redact one: those columns
    // are absent from the Prisma client entirely, so the instruction would be
    // silently ignored and the author would believe it had taken effect.
    for (const policy of TRANSFER_POLICIES) {
      const unsupported = new Set(MODEL_GRAPH[policy.model].unsupported);
      if (unsupported.size === 0) continue;

      const named = [
        ...(policy.redact ?? []),
        ...(policy.regenerate ?? []),
        ...Object.keys(policy.reset ?? {}),
      ].filter((column) => unsupported.has(column));

      expect(
        named,
        `${policy.model} names Unsupported column(s) ${named.join(', ')} in a write list. ` +
          `Prisma cannot read or write them, so the instruction would do nothing.`
      ).toEqual([]);
    }
  });

  it('keeps Unsupported columns out of the writable field list entirely', () => {
    // The structural reason the rule above is enough: Prisma omits these from
    // the datamodel, so the engine iterating `fields` can never reach one.
    for (const name of Object.keys(MODEL_GRAPH)) {
      const node = MODEL_GRAPH[name];
      const fieldNames = new Set(node.fields.map((f) => f.name));
      for (const column of node.unsupported) {
        expect(fieldNames.has(column), `${name}.${column} leaked into the writable fields`).toBe(
          false
        );
      }
    }
  });
});

describe('merge keys', () => {
  it('correspond to a real unique constraint', () => {
    for (const policy of TRANSFER_POLICIES) {
      if (!policy.mergeKeys) continue;
      const uniques = MODEL_GRAPH[policy.model].uniques.map((tuple) => [...tuple].sort().join('|'));

      for (const key of policy.mergeKeys) {
        const wanted = [...key].sort().join('|');
        expect(
          uniques,
          `${policy.model} merges on [${key.join(', ')}] but the schema has no such unique ` +
            `constraint. Without one, a re-import duplicates instead of matching.`
        ).toContain(wanted);
      }
    }
  });

  it('only claims a soft merge key where the schema offers nothing better', () => {
    // A soft key is a guess. Where a real constraint exists it must be preferred,
    // because the guess can be wrong and the constraint cannot.
    for (const policy of TRANSFER_POLICIES) {
      if (!policy.softMergeKey || policy.mergeKeys) continue;

      const realUniques = MODEL_GRAPH[policy.model].uniques.filter(
        (tuple) => tuple.join() !== 'id'
      );
      expect(
        realUniques,
        `${policy.model} uses a softMergeKey but the schema does have a unique ` +
          `constraint (${JSON.stringify(realUniques)}). Use mergeKeys instead.`
      ).toEqual([]);
    }
  });
});

describe('the secret guard', () => {
  it('accounts for every secret-shaped column on a model that leaves', () => {
    for (const policy of inBundle) {
      const accounted = new Set([
        ...(policy.redact ?? []),
        ...(policy.regenerate ?? []),
        ...Object.keys(policy.secretReviewed ?? {}),
      ]);

      const unaccounted = MODEL_GRAPH[policy.model].fields
        .filter(couldHoldASecret)
        .map((f) => f.name)
        .filter((name) => !accounted.has(name));

      expect(
        unaccounted,
        `${policy.model} has secret-shaped column(s) ${unaccounted.join(', ')} and is in the ` +
          `bundle. Add each to \`redact\` (drop it), \`regenerate\` (never written), or ` +
          `\`secretReviewed\` with a one-line reason it is not a secret.`
      ).toEqual([]);
    }
  });

  it('requires a reason for every reviewed exception', () => {
    for (const policy of TRANSFER_POLICIES) {
      for (const [column, reason] of Object.entries(policy.secretReviewed ?? {})) {
        expect(
          reason.trim().length,
          `${policy.model}.${column} is waved through the secret guard without a real reason`
        ).toBeGreaterThan(20);
      }
    }
  });
});

describe('references the database does not enforce', () => {
  it('classifies every suspected soft reference', () => {
    for (const policy of inBundle) {
      const declared = new Set([
        ...(policy.softRefs ?? []).map((r) => r.idColumn),
        ...Object.keys(policy.softRefsIgnored ?? {}),
      ]);
      // The owner column is rewritten from the session on every import, so it is
      // accounted for by definition rather than by declaration.
      if (policy.ownerColumn) declared.add(policy.ownerColumn);

      const unclassified = MODEL_GRAPH[policy.model].suspectedSoftRefs.filter(
        (column) => !declared.has(column)
      );

      expect(
        unclassified,
        `${policy.model} has reference-shaped column(s) ${unclassified.join(', ')} with no ` +
          `foreign key behind them. Declare each in \`softRefs\` (with the model it points at) ` +
          `or dismiss it in \`softRefsIgnored\` with a reason.`
      ).toEqual([]);
    }
  });

  it('points every soft reference at a model that exists', () => {
    for (const policy of TRANSFER_POLICIES) {
      for (const ref of policy.softRefs ?? []) {
        const targets = ref.model ? [ref.model] : Object.values(ref.typeMap ?? {});

        expect(
          targets.length,
          `${policy.model}.${ref.idColumn} declares neither a model nor a typeMap`
        ).toBeGreaterThan(0);

        for (const target of targets) {
          expect(
            MODEL_GRAPH[target],
            `${policy.model}.${ref.idColumn} points at \`${target}\`, which is not a model. ` +
              `If a new entity type was added, check it follows the Resparkable<Name> convention.`
          ).toBeDefined();
        }
      }
    }
  });

  it('gives every dismissal a reason', () => {
    for (const policy of TRANSFER_POLICIES) {
      for (const [column, reason] of Object.entries(policy.softRefsIgnored ?? {})) {
        expect(
          reason.trim().length,
          `${policy.model}.${column} is dismissed as "not a reference" without saying why`
        ).toBeGreaterThan(20);
      }
    }
  });
});

describe('Json columns', () => {
  it('decides about every Json column on a model that leaves', () => {
    for (const policy of inBundle) {
      const decided = new Set([
        ...(policy.jsonRefs ?? []).map((r) => r.column),
        ...Object.keys(policy.jsonOpaque ?? {}),
        ...Object.keys(policy.reset ?? {}),
      ]);

      const undecided = MODEL_GRAPH[policy.model].jsonColumns.filter((c) => !decided.has(c));

      expect(
        undecided,
        `${policy.model} has Json column(s) ${undecided.join(', ')} with no decision. ` +
          `A Json column is opaque to every tool we have, so somebody has to say whether it ` +
          `holds row ids: add it to \`jsonRefs\`, or to \`jsonOpaque\` with a reason it does not.`
      ).toEqual([]);
    }
  });

  it('gives every opaque declaration a reason', () => {
    for (const policy of TRANSFER_POLICIES) {
      for (const [column, reason] of Object.entries(policy.jsonOpaque ?? {})) {
        expect(
          reason.trim().length,
          `${policy.model}.${column} is declared id-free without saying why`
        ).toBeGreaterThan(20);
      }
    }
  });
});

describe('foreign keys that leave the transferable set', () => {
  it('accounts for every edge pointing at something that is not written back', () => {
    const writable = new Set(transferable.map((p) => p.model));
    const declared = new Set(CROSS_BOUNDARY_EDGES.map((e) => `${e.model}.${e.column}`));

    const dangling: string[] = [];

    for (const policy of transferable) {
      const node = MODEL_GRAPH[policy.model];

      for (const edge of node.relations) {
        // The owner column is set from the session, not resolved from the
        // bundle, so an edge built on it is not a dependency to satisfy.
        if (policy.ownerColumn && edge.fromFields.includes(policy.ownerColumn)) continue;
        if (writable.has(edge.toModel)) continue;
        if (edge.fromFields.some((c) => declared.has(`${policy.model}.${c}`))) continue;

        dangling.push(`${policy.model}.${edge.fromFields.join('+')} -> ${edge.toModel}`);
      }

      for (const ref of policy.softRefs ?? []) {
        const targets = ref.model ? [ref.model] : Object.values(ref.typeMap ?? {});
        if (targets.every((t) => writable.has(t))) continue;
        if (declared.has(`${policy.model}.${ref.idColumn}`)) continue;

        dangling.push(`${policy.model}.${ref.idColumn} -> ${targets.join('|')}`);
      }
    }

    expect(
      dangling,
      `These references point at models that are never written on import:\n  ` +
        `${dangling.join('\n  ')}\n` +
        `Rows depending on them will be dropped or nulled. Either make the target ` +
        `transferable, or declare the edge in \`crossBoundaryEdges\` with the reason ` +
        `so the behaviour is a decision rather than a surprise.`
    ).toEqual([]);
  });
});

describe('divergence from the Art. 15 manifest', () => {
  // These two manifests answer different questions and are meant to disagree.
  // Pinning the disagreements stops a future tidy-up merging them, which would
  // be the wrong fix for a real observation.
  const pinned: Array<{ model: string; expect: TransferPolicy['disposition']; because: string }> = [
    {
      model: 'Session',
      expect: 'skip',
      because: 'disclosable to its owner; transferring one is takeover',
    },
    {
      model: 'AiAdminAuditLog',
      expect: 'export-only',
      because: 'an importable audit log proves nothing',
    },
    {
      model: 'AiWorkflowExecution',
      expect: 'export-only',
      because: 'inbound runs store third-party trigger payloads verbatim',
    },
  ];

  it.each(pinned)('$model stays $expect — $because', ({ model, expect: disposition }) => {
    expect(policyFor(model)?.disposition).toBe(disposition);
  });

  it('keeps ContactSubmission out of transfer while Art. 15 exports it', () => {
    expect(policyFor('ContactSubmission')).toBeUndefined();
    expect(excludedByModel.get('ContactSubmission')).toBeDefined();
  });
});
