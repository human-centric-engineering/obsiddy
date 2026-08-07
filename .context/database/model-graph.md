# The generated model graph

`lib/portability/model-graph.generated.ts` is a machine-readable description of
the whole Prisma schema — every column, foreign key, unique constraint and
`Json` column across all ~80 models. It is rebuilt by every `prisma generate`
and checked into git.

**Do not edit it.** Run `npm run db:generate` and commit the result.

## Why it exists

Account transfer (`lib/portability/**`) has to know, for every table: which
column holds the owning user, which columns are foreign keys and where they
point, which are unique so a merge can match on them, and which are `Json` or
polymorphic so ids buried inside them can be rewritten.

All of that is already in the Prisma schema. Writing it down a second time by
hand is how the second copy drifts — and a drifted copy of _this_ table silently
exports the wrong rows, or attaches imported data to the wrong parent.

## Why it is generated rather than read at runtime

Prisma's runtime `Prisma.dmmf` **cannot** answer these questions. In Prisma 7 it
is pruned to `{ name, kind, type, relationName }` per field: no `isId`, no
nullability, no `relationFromFields`, no `uniqueFields`. The full datamodel is
only handed to a generator, at `prisma generate` time.

## Why a generator rather than a script

`prisma generate` is already both `postinstall` and `npm run db:generate`. So the
graph cannot go stale relative to the client: you cannot regenerate one without
regenerating the other. A `scripts/` equivalent would have to be remembered, and
`prisma migrate dev` would not run it.

The generator block lives in `prisma/schema/framework-resparkable.prisma` rather
than `base.prisma` only because the latter is Sunrise-owned. See ask #37 in
[`sunrise-asks.md`](../framework/resparkable/sunrise-asks.md) — if upstream
adopts it, **delete the local block in the same change**, because two generators
sharing a name is a hard `prisma generate` error.

## Three drift checks

| Check                                     | Catches                                                              | Where                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `SCHEMA_FINGERPRINT` recomputed from disk | A schema edit with no regeneration — e.g. `prisma migrate dev` alone | `tests/unit/lib/portability/model-graph.test.ts`, fails locally in watch mode |
| `prisma generate && git diff --exit-code` | A hand-edited generated file                                         | CI                                                                            |
| Coverage guard                            | A new model with no transfer policy                                  | `tests/unit/lib/portability/policy-coverage.test.ts`                          |

The fingerprint algorithm is shared between the generator and the test
(`prisma/generators/schema-fingerprint.mjs`) rather than implemented twice — a
drift check that can itself drift goes green while the thing it guards is stale.

## Two things the schema does not say plainly

**`Unsupported()` columns are invisible to Prisma.** `ResparkableEmbedding.embedding`,
`ResparkableTask.searchVector`, `AiKnowledgeChunk.embedding` and friends are
absent from the datamodel entirely — not flagged within it. The generator
recovers them from the schema text into `ModelNode.unsupported`. They can never
be read or written through the client, so the engine cannot touch them by
accident; they are recorded so an export can say it left them behind and an
import can queue the work that rebuilds them.

A model may transfer _and_ have them: `ResparkableTask.searchVector` is
`GENERATED ALWAYS AS … STORED`, so Postgres fills it on insert.

**`suspectedSoftRefs` finds references the database does not enforce.** A
`String` column named `<x>Id` — or one of the owner-ish names the privacy guard
already watches — that no relation claims. These are the dangerous ones: a real
foreign key fails loudly when its target is missing, but a string holding an id
just keeps pointing at something that is no longer there.

The heuristic finds exactly the known set and several that were not on anyone's
list — `AiConversation.summaryUpToMessageId`, `AiMessage.workflowExecutionId`.
Discovery is mechanical; what each one _means_ is a human decision recorded in
the transfer policy, and the coverage guard fails until every one is either
declared or explicitly dismissed with a reason.

## Shape

Types are hand-written in `lib/portability/model-graph-types.ts`; the generated
file is pure data that satisfies them. Splitting them keeps a regeneration diff
showing only what the schema changed.

```ts
MODEL_GRAPH['ResparkableGoal'];
// {
//   name, delegate: 'resparkableGoal', table: 'framework_resparkable_goal',
//   sourceFile: 'framework-resparkable.prisma',
//   idFields: ['id'],
//   fields: [{ name, type, isRequired, isUnique, maxLength, documentation, … }],
//   relations: [{ fromFields: ['areaId'], toFields: ['id'], toModel: 'ResparkableArea',
//                 onDelete: 'SetNull', optional: true, isSelfReference: false }],
//   uniques: [['id']],
//   unsupported: [], jsonColumns: [], suspectedSoftRefs: [],
// }
```

### Telling an ordering edge from a remapping edge

Every brain table has a relation to `ResparkableSpace` on `userId`, because
`userId` is simultaneously the owner column and the foreign key to the space row.
That edge is a real ordering dependency — the space must be written first — but
its value comes from the session, not from the id-map.

The two are distinguished by comparing `toFields` against the target's
`idFields`:

```ts
// ordering only — points at ResparkableSpace.userId, not its primary key
{ fromFields: ['userId'], toFields: ['userId'], toModel: 'ResparkableSpace' }

// a real id remap — points at the primary key
{ fromFields: ['areaId'], toFields: ['id'], toModel: 'ResparkableArea' }
```

Derived rather than declared, so it stays correct as models are added. Pinned by
a test in `model-graph.test.ts`.

## See also

- [`.context/framework/resparkable/transfer.md`](../framework/resparkable/transfer.md) — the policy layer built on this
- `lib/portability/policy.ts` — the vocabulary
- `prisma/generators/portability.mjs` — the generator
