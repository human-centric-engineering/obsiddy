/**
 * Finding ids inside `Json` columns — the declared ones, and the ones nobody
 * declared.
 *
 * A `Json` column is opaque to every tool this system has. The generated graph
 * can say that `ResparkableBoard.filter` is `Json`; it cannot say that a project
 * id lives at `filter.projectId`, so the policy manifest declares that by hand
 * ({@link JsonRef}). Hand-written declarations are exactly the kind that go
 * quietly stale — a renderer gains a field, the declaration keeps matching the
 * old shape, and an import writes a board pointing at a project in a different
 * account's numbering.
 *
 * So there are two jobs here and they are deliberately different.
 *
 * **Reading a declared path** is what the import acts on. Precise, cheap, and
 * limited to what somebody has thought about.
 *
 * **The canary** is what tells us the declarations are incomplete. It walks the
 * whole value and reports any string that is a key in this run's id-map but sits
 * somewhere no declaration covers. It never rewrites anything — a finding is
 * evidence that the manifest needs an edit, not a licence to guess. That is the
 * whole distinction: acting on an undeclared id would be the same silent
 * remapping the declarations exist to make reviewable.
 *
 * The canary works on real data, which is why it catches what static analysis
 * cannot. It also cannot produce a false positive worth worrying about: the
 * id-map is keyed by ids this very bundle emitted, so a coincidental hit would
 * need a 25-character collision.
 *
 * @see lib/portability/policy.ts — the `JsonRef` vocabulary and the `'**'` note
 * @see lib/portability/import-plan.ts — the caller
 */

/**
 * Limits on walking one value.
 *
 * `Json` arrives from an uploaded file, so its depth and size are somebody
 * else's decision. Both caps stop rather than throw: a walk that is cut short is
 * reported as cut short, and a report that says "I stopped looking" is more
 * useful than a refused import — the declared paths still resolve, and it is
 * only the canary's completeness that is affected.
 */
export const JSON_WALK_CAPS = {
  /** Values visited in one column. */
  maxNodes: 100_000,
  /** Nesting depth. Deeper than this is a generated structure, not a config. */
  maxDepth: 32,
  /**
   * Strings longer than this are never tested against the id-map.
   *
   * An id is 25 characters (cuid) or 36 (uuid). Anything longer is prose, and
   * skipping it keeps the canary from hashing every message body in an account
   * to learn what its length already said.
   */
  maxIdLength: 64,
} as const;

/** One string found inside a `Json` value, and where it was found. */
export interface JsonStringAt {
  /**
   * Dot path with array indices collapsed to `[]`.
   *
   * `staleItems[3].id` reads as `staleItems[].id`, which is the form the policy
   * manifest declares. Collapsing means a declaration covers every element of an
   * array rather than element zero, which is what anybody writing one intends.
   */
  path: string;
  value: string;
}

/** What a walk found, and whether it saw everything. */
export interface JsonWalk {
  strings: JsonStringAt[];
  /** A cap was reached and the rest of the value was not examined. */
  truncated: boolean;
}

/** Append a key to a path, handling the root. */
function child(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

/**
 * Every string in a value, with its collapsed path.
 *
 * Iterative rather than recursive: the input is untrusted, and a recursive walk
 * of a deeply nested value overflows the stack before the depth cap can decline
 * it — an error nobody can act on, thrown from a frame nobody can read.
 */
export function walkJsonStrings(value: unknown): JsonWalk {
  const strings: JsonStringAt[] = [];
  const stack: { value: unknown; path: string; depth: number }[] = [{ value, path: '', depth: 0 }];
  let nodes = 0;
  let truncated = false;

  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;

    nodes += 1;
    if (nodes > JSON_WALK_CAPS.maxNodes) {
      truncated = true;
      break;
    }

    const current = frame.value;

    if (typeof current === 'string') {
      strings.push({ path: frame.path, value: current });
      continue;
    }

    if (current === null || typeof current !== 'object') continue;

    if (frame.depth >= JSON_WALK_CAPS.maxDepth) {
      truncated = true;
      continue;
    }

    if (Array.isArray(current)) {
      // Every element shares the parent's path with `[]` appended, which is what
      // collapses `items[0]` and `items[7]` into one declarable position.
      for (const element of current) {
        stack.push({ value: element, path: `${frame.path}[]`, depth: frame.depth + 1 });
      }
      continue;
    }

    for (const [key, entry] of Object.entries(current)) {
      stack.push({ value: entry, path: child(frame.path, key), depth: frame.depth + 1 });
    }
  }

  return { strings, truncated };
}

/**
 * Whether a declared path covers a found path.
 *
 * `'**'` covers everything — the honest unknown, for a column whose shape
 * genuinely varies. Otherwise the match is exact against the collapsed form, so
 * `staleItems[].id` covers `staleItems[].id` and nothing else. Prefix matching
 * was considered and rejected: `filter` would then cover `filter.projectId`
 * *and* `filter.secretToken`, which is the opposite of what a precise
 * declaration is for.
 */
export function jsonPathCovers(declared: string, found: string): boolean {
  return declared === '**' || declared === found;
}

/**
 * The strings at one declared path.
 *
 * Walks the whole value and filters, rather than descending the path directly.
 * The walk is bounded and already written, and the direct descent would need its
 * own handling for `[]` at every level — a second traversal to keep in step with
 * the first, for a saving that does not exist at these sizes.
 */
export function jsonStringsAt(value: unknown, declaredPath: string): JsonWalk {
  const walk = walkJsonStrings(value);
  return {
    strings: walk.strings.filter((entry) => jsonPathCovers(declaredPath, entry.path)),
    truncated: walk.truncated,
  };
}

/** An id found somewhere no declaration covers. */
export interface CanaryFinding {
  /** The collapsed path within the column. */
  path: string;
  /** The id itself. Safe to show: it is one this bundle already contains. */
  value: string;
}

/** What the canary found in one column, and whether it saw the whole value. */
export interface CanaryResult {
  findings: CanaryFinding[];
  truncated: boolean;
}

/**
 * Look for ids in positions the manifest does not declare.
 *
 * Reports; never rewrites. See the header — the point of a finding is that
 * somebody adds a `jsonRefs` entry or a `jsonOpaque` reason, having looked at
 * what the column actually holds.
 *
 * @param value the column's contents
 * @param declaredPaths every path declared for this column
 * @param isKnownId membership in this run's id-map
 */
export function canaryScan(
  value: unknown,
  declaredPaths: readonly string[],
  isKnownId: (candidate: string) => boolean
): CanaryResult {
  const walk = walkJsonStrings(value);
  const findings: CanaryFinding[] = [];
  const seen = new Set<string>();

  for (const entry of walk.strings) {
    if (entry.value.length > JSON_WALK_CAPS.maxIdLength) continue;
    if (declaredPaths.some((declared) => jsonPathCovers(declared, entry.path))) continue;
    if (!isKnownId(entry.value)) continue;

    // One finding per (path, id). A thousand rows all carrying the same
    // undeclared shape is one thing to fix, and reporting it a thousand times
    // would bury the second, different one.
    const key = `${entry.path}\u0000${entry.value}`;
    if (seen.has(key)) continue;
    seen.add(key);

    findings.push({ path: entry.path, value: entry.value });
  }

  return { findings, truncated: walk.truncated };
}
