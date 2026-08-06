/**
 * Unit Tests: the triage evaluation dataset.
 *
 * A benchmark with a broken case does not fail — it just reports a lower score
 * for ever, and the first person to see the drop goes looking in the agent. So
 * the properties that make the thirty cases meaningful are asserted here rather
 * than trusted: that every expected link names something the frame actually
 * offered, that the case ids are unique (they key the report and the seed's
 * metadata), and that the frame carries the thought it is supposed to be about.
 *
 * The spread assertion is the unusual one. A dataset that has drifted to
 * twenty-eight `leave` cases still scores well against an agent that files
 * nothing, which is precisely the regression this is meant to catch — so the
 * balance between the three decisions is part of the contract.
 *
 * Test Coverage:
 * - Thirty cases, unique ids, every id kebab-case
 * - Every expected link is a slug the frame lists
 * - `leave` never carries links
 * - All three decisions well represented
 * - Every case carries a note explaining the expected answer
 * - The frame contains the thought, the snapshot and the output contract
 *
 * @see lib/framework/resparkable/evaluations/triage-cases.ts
 */

import { describe, expect, it } from 'vitest';

import {
  buildTriageCaseInput,
  RESPARKABLE_TRIAGE_CASES,
  TRIAGE_DECISIONS,
  TRIAGE_SNAPSHOT_GOALS,
  TRIAGE_SNAPSHOT_PROJECTS,
  TRIAGE_SNAPSHOT_SLUGS,
} from '@/lib/framework/resparkable/evaluations/triage-cases';

describe('the triage dataset', () => {
  it('holds thirty cases with unique, readable ids', () => {
    expect(RESPARKABLE_TRIAGE_CASES).toHaveLength(30);
    const ids = RESPARKABLE_TRIAGE_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('never expects a link the frame did not offer', () => {
    // An expected slug outside the snapshot is unreachable: the grader drops
    // unknown slugs from the agent's answer, so the case could never score
    // above 0.5 no matter how right the agent was.
    const allowed = new Set(TRIAGE_SNAPSHOT_SLUGS);
    for (const testCase of RESPARKABLE_TRIAGE_CASES) {
      for (const slug of testCase.expected.linkTo) {
        expect(allowed.has(slug), `${testCase.id} expects unknown ${slug}`).toBe(true);
      }
    }
  });

  it('never asks for links on a thought it also says to leave alone', () => {
    for (const testCase of RESPARKABLE_TRIAGE_CASES) {
      if (testCase.expected.decision !== 'leave') continue;
      expect(testCase.expected.linkTo, `${testCase.id}`).toEqual([]);
    }
  });

  it('always asks for at least one link on a "link" case', () => {
    // "Belongs with something that exists" and "belongs with nothing" is the
    // same answer as `leave`; a link case with no link is a mislabelled leave.
    for (const testCase of RESPARKABLE_TRIAGE_CASES) {
      if (testCase.expected.decision !== 'link') continue;
      expect(testCase.expected.linkTo.length, `${testCase.id}`).toBeGreaterThan(0);
    }
  });

  it('keeps all three decisions well represented', () => {
    for (const decision of TRIAGE_DECISIONS) {
      const count = RESPARKABLE_TRIAGE_CASES.filter((c) => c.expected.decision === decision).length;
      expect(count, `${decision} cases`).toBeGreaterThanOrEqual(6);
    }
  });

  it('explains every expected answer', () => {
    for (const testCase of RESPARKABLE_TRIAGE_CASES) {
      expect(testCase.note.length, `${testCase.id} has no note`).toBeGreaterThan(30);
      expect(testCase.thought.length).toBeGreaterThan(0);
    }
  });
});

describe('buildTriageCaseInput', () => {
  const input = buildTriageCaseInput('email priya the revised pricing doc by friday');

  it('carries the thought verbatim', () => {
    expect(input).toContain('email priya the revised pricing doc by friday');
  });

  it('lists every project and goal a verdict may name', () => {
    for (const project of TRIAGE_SNAPSHOT_PROJECTS) expect(input).toContain(project.slug);
    for (const goal of TRIAGE_SNAPSHOT_GOALS) expect(input).toContain(goal.slug);
  });

  it('states the output contract and the three decisions', () => {
    expect(input).toContain('"decision"');
    expect(input).toContain('"linkTo"');
    for (const decision of TRIAGE_DECISIONS) expect(input).toContain(`"${decision}"`);
  });

  it('tells the agent the snapshot is not real, which is what keeps it off the tools', () => {
    expect(input).toContain('exist in no brain');
    expect(input).toContain('no tool calls');
  });
});
