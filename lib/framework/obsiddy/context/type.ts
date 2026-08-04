/**
 * The `contextType` string, alone in its own module.
 *
 * Split out so `context/invalidate.ts` — imported by every mutating service —
 * can name the type without pulling in `contributor.ts`, and through it the
 * snapshot service and half the repo layer. A constant should not cost a
 * dependency graph.
 */
export const OBSIDDY_CONTEXT_TYPE = 'obsiddy';
