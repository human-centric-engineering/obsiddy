/**
 * The markdown codec — frontmatter in, frontmatter out, body untouched.
 * **Pure**: no DB, no network, no clock. The whole conflict story downstream
 * rests on this file being deterministic, so it is driven directly by a table
 * test with no mocks (§14 purity).
 *
 * ## Why not `gray-matter`
 *
 * §14 is explicit, and the reason survives contact with the code: a 40-line
 * parse/serialise over `yaml@2` gives control of delimiter, BOM and CRLF
 * handling, and `yaml@2` preserves comments and formatting when rewriting — which
 * matters enormously when the file you are rewriting is one somebody has been
 * editing by hand.
 *
 * ## The body is verbatim. This is a hard rule.
 *
 * Never reflow, never reformat, never re-wrap, never "tidy" a list. The vault is
 * a text editor and this is not; three paragraphs lost to a well-meaning
 * normaliser is unrecoverable and unforgivable. The only transformation applied
 * to a body anywhere in this module is CRLF → LF **for hashing**, and that never
 * touches what is written to disk.
 *
 * ## Two hashes, because the round-trip is lossy in exactly one direction
 *
 * Frontmatter is *regenerated* from the database on every write; a body is
 * carried through verbatim. So a single whole-file hash cannot tell "the user
 * edited the prose" from "we re-serialised the YAML with different quoting", and
 * those need opposite responses. {@link normalisedHashes} returns both.
 *
 * **Compare normalised forms, not raw bytes.** YAML key order, quote style, CRLF
 * and a trailing newline otherwise produce something like 80% of all reported
 * conflicts, and a tool that cries conflict on a file nobody touched loses trust
 * in week one (§14 change detection).
 *
 * ## Deliberately absent: `updated:`
 *
 * A mutating timestamp in frontmatter means every database touch rewrites every
 * file, which re-triggers hashing and re-embedding for a change nobody made.
 * Obsidian users get mtime from the filesystem. This one omission is worth more
 * than it looks.
 */

import { createHash } from 'crypto';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/** A file that is not a note we can read. Reported per-file, never thrown out. */
export class VaultNoteParseError extends Error {
  constructor(
    message: string,
    /** Short machine-readable cause, surfaced in the import report. */
    readonly reason: string
  ) {
    super(message);
    this.name = 'VaultNoteParseError';
  }
}

/** A parsed note: its frontmatter map and everything after the closing fence. */
export interface ParsedNote {
  frontmatter: Record<string, unknown>;
  body: string;
}

const FENCE = '---';

/**
 * Strip a UTF-8 BOM.
 *
 * Windows editors and some git configurations add one, and a BOM before the
 * opening `---` makes the frontmatter fence unrecognisable — the file then
 * parses as a body with no frontmatter, loses its `obsiddy-id`, and imports as a
 * brand-new duplicate of something that already exists. That failure is silent
 * and it is a duplicate of the user's entire vault, so it is worth three lines.
 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Split a note into frontmatter and body.
 *
 * A file with no frontmatter fence is valid — it parses to an empty map and the
 * whole file as body. That is what a note a user created in Obsidian looks like
 * before we have ever touched it, and refusing it would mean new notes could
 * only be created in the app.
 *
 * @throws {VaultNoteParseError} when the YAML is malformed, or when it parses to
 *   something that is not a mapping (a bare list or scalar). Both mean we cannot
 *   read the file's identity, and guessing is worse than reporting.
 */
export function parseNote(raw: string): ParsedNote {
  const text = stripBom(raw);

  if (!text.startsWith(`${FENCE}\n`) && !text.startsWith(`${FENCE}\r\n`)) {
    return { frontmatter: {}, body: text };
  }

  const afterOpening = text.slice(text.indexOf('\n') + 1);
  // The closing fence is a `---` alone on its own line. Searching for the
  // *line* rather than the substring is what stops a `---` horizontal rule in
  // the prose from truncating the note.
  const closing = afterOpening.search(/^---[ \t]*\r?$|^---[ \t]*$/m);

  if (closing === -1) {
    throw new VaultNoteParseError(
      'Frontmatter was opened with --- but never closed',
      'unterminated-frontmatter'
    );
  }

  const yamlText = afterOpening.slice(0, closing);
  const rest = afterOpening.slice(closing);
  // `rest` opens with the closing fence. When the file ends there — no trailing
  // newline, which hand-editing and some git configs produce routinely — there
  // is no newline to skip past, and `slice(indexOf(…) + 1)` would return the
  // fence itself. An empty body has to read as empty: `"---"` would be written
  // straight into the row's prose on import.
  const newlineAt = rest.indexOf('\n');
  const body = newlineAt === -1 ? '' : rest.slice(newlineAt + 1);

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText, { maxAliasCount: 100 });
  } catch (error) {
    throw new VaultNoteParseError(
      `Frontmatter is not valid YAML: ${error instanceof Error ? error.message : 'unknown error'}`,
      'invalid-yaml'
    );
  }

  if (parsed === null || parsed === undefined) return { frontmatter: {}, body };

  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new VaultNoteParseError(
      'Frontmatter must be a mapping of keys to values',
      'frontmatter-not-a-mapping'
    );
  }

  return { frontmatter: parsed as Record<string, unknown>, body };
}

/**
 * Render frontmatter and body back into a file.
 *
 * Keys are written in insertion order — the encoder controls that, so
 * `obsiddy-id` and `obsiddy-type` lead every file and a human opening one in a
 * text editor sees what it is on the first line. `null` and `undefined` values
 * are dropped rather than written as `key: null`: an empty key is noise in a
 * file somebody reads, and on the way back in it is indistinguishable from
 * "unset" anyway.
 */
export function serialiseNote({ frontmatter, body }: ParsedNote): string {
  const present = Object.entries(frontmatter).filter(
    ([, value]) => value !== null && value !== undefined
  );

  const trailing = body.endsWith('\n') || body.length === 0 ? '' : '\n';

  if (present.length === 0) return `${body}${trailing}`;

  const yamlText = stringifyYaml(Object.fromEntries(present), {
    lineWidth: 0, // Never fold a long value across lines — it survives a round
    // trip either way, but a wrapped URL is miserable to read.
  });

  return `${FENCE}\n${yamlText}${FENCE}\n\n${body}${trailing}`;
}

/**
 * Sort a frontmatter map deeply so key order cannot affect a hash.
 *
 * `yaml` emits keys in insertion order and Obsidian rewrites frontmatter in its
 * own order, so two files with identical meaning routinely differ in key order.
 * Without this, opening a note in Obsidian and closing it again is a "change".
 */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== null && item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, item]) => [key, sortDeep(item)]));
  }
  // Dates are what `yaml` would give back for a timestamp under a schema that
  // has one. Comparing them as ISO strings keeps them alongside the string case.
  if (value instanceof Date) return value.toISOString();

  // **Every scalar is compared as a string.** Quoting is presentation in YAML
  // but it changes the *type* — `estimate: 30` is a number and `estimate: "30"`
  // is a string — and any editor that rewrites frontmatter may quote or unquote
  // freely. Comparing the rendered value is what stops "Obsidian saved this
  // file" from reading as an edit. The frontmatter schemas accept both
  // spellings for the same reason.
  //
  // Narrowed by `typeof` rather than a bare `String(value)`: objects and arrays
  // are already handled above, but the parameter is `unknown`, and letting an
  // unexpected type through as `[object Object]` would make two different values
  // hash alike — a change that silently does not register.
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return value === null || value === undefined ? value : JSON.stringify(value);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Normalise a body for comparison **only**. Never write this back to a file.
 *
 * CRLF → LF and a trimmed trailing newline. Nothing else: internal whitespace,
 * blank-line runs and trailing spaces on a line are all things a person may have
 * put there on purpose, and collapsing them here would make a real edit
 * invisible to change detection.
 */
export function normaliseBodyForHash(body: string): string {
  return body.replace(/\r\n/g, '\n').trimEnd();
}

/** The two hashes that decide whether a note changed, and on which side. */
export interface NoteHashes {
  /** Frontmatter + body — "did this file change at all". */
  full: string;
  /** Body alone — "did the prose change", the half the vault wins. */
  body: string;
}

export function normalisedHashes(note: ParsedNote): NoteHashes {
  const body = normaliseBodyForHash(note.body);
  const frontmatter = JSON.stringify(sortDeep(note.frontmatter));

  return {
    full: sha256(`${frontmatter}\n${body}`),
    body: sha256(body),
  };
}

/**
 * A `[[Wikilink]]` for a title, with the pipe-alias form when a display name is
 * wanted.
 *
 * Structural edges go in frontmatter as wikilinks rather than as raw ids
 * precisely so Obsidian resolves them and draws them in its own graph (§14). An
 * id would be correct and useless — the file would show no links at all in the
 * one application whose graph view is the reason someone wanted this.
 */
export function wikilink(target: string): string {
  // `]]` inside a link target terminates it; `|` starts an alias. Neither is
  // recoverable, so they are replaced rather than escaped — Obsidian has no
  // escape syntax for either.
  return `[[${target.replace(/[[\]|]/g, ' ').trim()}]]`;
}

/** The single target inside a `[[…]]`, or `null` if the value is not a wikilink. */
export function parseWikilink(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^\s*\[\[([^\]]+)\]\]\s*$/.exec(value);
  if (!match) return null;
  // `[[Note|display]]` — the target is the part before the pipe.
  return match[1].split('|')[0].trim() || null;
}

/**
 * Every `[[wikilink]]` in a block of prose.
 *
 * §14 calls the free-prose case the highest-leverage line in the subsystem: one
 * regex pass turns "I mentioned this project in a note" into a proposed link.
 * Import writes those as `proposed`, never accepted, so prose mentions can never
 * pollute prioritisation.
 */
export function extractWikilinks(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
    const target = match[1].split('|')[0].trim();
    if (target) found.add(target);
  }
  return [...found];
}
