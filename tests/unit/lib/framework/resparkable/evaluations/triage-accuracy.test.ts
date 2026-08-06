/**
 * Unit Tests: the triage-accuracy grader.
 *
 * This grader exists to answer one question — "did that prompt edit make triage
 * worse?" — and a grader with a quiet arithmetic bug answers it confidently and
 * wrongly. Worse, it fails in the reassuring direction: a scorer that is too
 * generous makes every change look harmless.
 *
 * So the arithmetic is pinned by a table rather than by a couple of happy-path
 * cases, and the parser is tested against the shapes a model actually returns
 * (a bare object, a fenced one, one buried in an explanation) rather than only
 * the shape the prompt asked for.
 *
 * Test Coverage:
 * - F1 over link sets, including both-empty (1) and one-empty (0)
 * - The 0.5/0.5 split between decision and links, at every combination
 * - Unknown slugs dropped, not double-counted
 * - Case-insensitive, whitespace-tolerant, duplicate-tolerant link matching
 * - Parsing: bare JSON, code fence, JSON inside prose, unparseable
 * - `grade()` — pass threshold, unparseable output scores 0, missing reference
 *   scores null
 *
 * @see lib/framework/resparkable/evaluations/triage-accuracy.ts
 */

import { describe, expect, it } from 'vitest';

import {
  linkF1,
  resparkableTriageAccuracyGrader,
  parseTriageVerdict,
  scoreTriageVerdict,
} from '@/lib/framework/resparkable/evaluations/triage-accuracy';
import type { TriageVerdict } from '@/lib/framework/resparkable/evaluations/triage-cases';

const PROJECT = 'project:website-relaunch';
const OTHER_PROJECT = 'project:q3-pricing-review';
const GOAL = 'goal:ship-v2-by-october';

const verdict = (decision: TriageVerdict['decision'], linkTo: string[] = []): TriageVerdict => ({
  decision,
  linkTo,
});

const config = { passThreshold: 0.8 };

describe('linkF1', () => {
  it.each([
    { name: 'both empty', expected: [], actual: [], f1: 1 },
    { name: 'expected empty, actual not', expected: [], actual: [PROJECT], f1: 0 },
    { name: 'actual empty, expected not', expected: [PROJECT], actual: [], f1: 0 },
    { name: 'exact single', expected: [PROJECT], actual: [PROJECT], f1: 1 },
    { name: 'wrong single', expected: [PROJECT], actual: [OTHER_PROJECT], f1: 0 },
    { name: 'exact pair', expected: [PROJECT, GOAL], actual: [GOAL, PROJECT], f1: 1 },
    // One of two found: precision 1, recall 0.5 → F1 2/3. This is the case the
    // grader uses F1 for at all — an exact-match grader would score it 0 and
    // call it no better than naming neither.
    { name: 'half of a pair', expected: [PROJECT, GOAL], actual: [PROJECT], f1: 2 / 3 },
    // One right, one invented: precision 0.5, recall 1 → F1 2/3.
    { name: 'one right one extra', expected: [PROJECT], actual: [PROJECT, GOAL], f1: 2 / 3 },
  ])('$name → $f1', ({ expected, actual, f1 }) => {
    expect(linkF1(new Set(expected), new Set(actual))).toBeCloseTo(f1, 10);
  });
});

describe('scoreTriageVerdict', () => {
  it('gives a perfect answer 1', () => {
    const result = scoreTriageVerdict(verdict('task', [PROJECT]), verdict('task', [PROJECT]));
    expect(result.score).toBe(1);
    expect(result.decisionMatched).toBe(true);
    expect(result.reasoning).toBe('');
  });

  it('halves the score when the decision is right and the links are not', () => {
    const result = scoreTriageVerdict(verdict('task', [PROJECT]), verdict('task', [OTHER_PROJECT]));
    expect(result.score).toBe(0.5);
    expect(result.reasoning).toContain('links');
    expect(result.reasoning).not.toContain('decision:');
  });

  it('halves the score when the links are right and the decision is not', () => {
    const result = scoreTriageVerdict(verdict('task', [PROJECT]), verdict('link', [PROJECT]));
    expect(result.score).toBe(0.5);
    expect(result.reasoning).toContain('expected "task", got "link"');
  });

  it('gives nothing for getting both wrong', () => {
    const result = scoreTriageVerdict(verdict('task', [PROJECT]), verdict('leave', []));
    expect(result.score).toBe(0);
  });

  it('scores a correct leave as a full mark — both link sets are empty', () => {
    expect(scoreTriageVerdict(verdict('leave'), verdict('leave')).score).toBe(1);
  });

  it('drops slugs outside the snapshot rather than punishing them twice', () => {
    // Precision already falls because the invented slug is not in the expected
    // set. Counting it again would score one mistake twice — so an invented
    // slug lands on the same score as naming nothing extra at all.
    const invented = scoreTriageVerdict(
      verdict('task', [PROJECT]),
      verdict('task', [PROJECT, 'project:does-not-exist'])
    );
    expect(invented.score).toBe(1);
  });

  it('matches links case-insensitively, trimmed and de-duplicated', () => {
    const result = scoreTriageVerdict(
      verdict('link', [PROJECT]),
      verdict('link', [`  ${PROJECT.toUpperCase()} `, PROJECT])
    );
    expect(result.score).toBe(1);
  });
});

describe('parseTriageVerdict', () => {
  it('reads a bare object', () => {
    expect(parseTriageVerdict('{"decision":"task","linkTo":["' + PROJECT + '"]}')).toEqual({
      decision: 'task',
      linkTo: [PROJECT],
    });
  });

  it('reads one inside a code fence', () => {
    const raw = '```json\n{"decision":"leave","linkTo":[]}\n```';
    expect(parseTriageVerdict(raw)).toEqual({ decision: 'leave', linkTo: [] });
  });

  it('reads one the model explained itself around', () => {
    // Not the requested shape, but the classification underneath is right, and
    // the grader is for measuring triage rather than obedience to formatting.
    const raw =
      'Looking at this, it belongs with the site work.\n{"decision":"link","linkTo":[]}\nHope that helps.';
    expect(parseTriageVerdict(raw)).toEqual({ decision: 'link', linkTo: [] });
  });

  it('defaults a missing linkTo to empty rather than failing', () => {
    expect(parseTriageVerdict('{"decision":"leave"}')).toEqual({ decision: 'leave', linkTo: [] });
  });

  it.each([
    ['prose only', 'I would leave this one alone.'],
    ['an unknown decision', '{"decision":"maybe","linkTo":[]}'],
    ['no decision at all', '{"linkTo":[]}'],
    ['empty', ''],
  ])('returns null for %s', (_name, raw) => {
    expect(parseTriageVerdict(raw)).toBeNull();
  });
});

describe('resparkableTriageAccuracyGrader.grade', () => {
  const base = { userInput: 'a captured thought', config };

  it('passes a case that matched exactly', async () => {
    const result = await resparkableTriageAccuracyGrader.grade({
      ...base,
      modelOutput: JSON.stringify(verdict('task', [PROJECT])),
      expectedOutput: JSON.stringify(verdict('task', [PROJECT])),
    });
    expect(result.score).toBe(1);
    expect(result.passed).toBe(true);
  });

  it('fails a right decision with entirely wrong links — 0.5 is below the bar on purpose', async () => {
    const result = await resparkableTriageAccuracyGrader.grade({
      ...base,
      modelOutput: JSON.stringify(verdict('task', [OTHER_PROJECT])),
      expectedOutput: JSON.stringify(verdict('task', [PROJECT])),
    });
    expect(result.score).toBe(0.5);
    expect(result.passed).toBe(false);
  });

  it('scores an unparseable reply zero, and quotes it back', async () => {
    const result = await resparkableTriageAccuracyGrader.grade({
      ...base,
      modelOutput: 'I have filed this under the website project for you.',
      expectedOutput: JSON.stringify(verdict('leave')),
    });
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.reasoning).toContain('filed this under');
  });

  it('scores null — not zero — when the case has no expected answer', async () => {
    // A broken case is not a failing agent. Null keeps it out of the mean;
    // zero would look like a regression in the subject.
    const result = await resparkableTriageAccuracyGrader.grade({
      ...base,
      modelOutput: JSON.stringify(verdict('leave')),
    });
    expect(result.score).toBeNull();
  });

  it('declares that it needs a reference, so the worker refuses a dataset without one', () => {
    expect(resparkableTriageAccuracyGrader.referenceRequired).toBe(true);
    expect(resparkableTriageAccuracyGrader.family).toBe('heuristic');
  });
});
