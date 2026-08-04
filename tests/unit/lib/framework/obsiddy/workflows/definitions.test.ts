/**
 * Unit Tests: the Obsiddy workflow definitions.
 *
 * These are pure data, which is exactly why they need a test. Every mistake
 * available here is one that costs nothing at build time, passes review by
 * looking plausible, and then fails at 3am on somebody's schedule with no user
 * watching: a step naming a capability slug that does not exist, an
 * `agent_call` pointing at an unseeded agent, a `nextSteps` edge to a step id
 * that was renamed, an `entryStepId` that no longer matches.
 *
 * So this validates them the way the engine will: against the real
 * `workflowDefinitionSchema`, with the slug references resolved against the real
 * catalogue and agent list rather than against copies.
 *
 * Two properties beyond structural validity:
 *
 * **Every workflow has a cost cap.** `plan.md` §6 is explicit that a step's
 * `budgetLimitUsd` caps only that step, so a runaway run is capped by
 * `AiWorkflow.maxCostPerExecutionUsd` or by nothing — and "by nothing" is the
 * failure nobody notices until the invoice.
 *
 * **No step names a user.** The owner arrives on `execution.userId`, stamped by
 * the scheduler from `createdBy`. A userId in a step config would be a second,
 * weaker path to the same thing, and the one an LLM could influence.
 *
 * @see lib/framework/obsiddy/workflows/definitions.ts
 */

import { describe, it, expect } from 'vitest';

import { OBSIDDY_WORKFLOWS } from '@/lib/framework/obsiddy/workflows/definitions';
import { OBSIDDY_CAPABILITY_SLUGS } from '@/lib/framework/obsiddy/capabilities/catalogue';
import { OBSIDDY_AGENT_SLUGS } from '@/lib/framework/obsiddy/agents';
import { OBSIDDY_SCHEDULED_WORKFLOWS } from '@/lib/framework/obsiddy/schedules/ensure';
import { OBSIDDY_WORKFLOW_SLUG_PREFIX } from '@/lib/framework/obsiddy/repo/schedules';
import { workflowDefinitionSchema } from '@/lib/validations/orchestration';

const CAPABILITY_SLUGS = new Set<string>(Object.values(OBSIDDY_CAPABILITY_SLUGS));
const AGENT_SLUGS = new Set<string>(Object.values(OBSIDDY_AGENT_SLUGS));

describe('the workflow set', () => {
  it('covers exactly the workflows ensureObsiddySchedules creates rows for', () => {
    // A schedule with no workflow silently never runs; a workflow with no
    // schedule silently never fires. Both are invisible.
    expect(OBSIDDY_WORKFLOWS.map((w) => w.slug).sort()).toEqual(
      Object.values(OBSIDDY_SCHEDULED_WORKFLOWS).sort()
    );
  });

  it('namespaces every slug, which is what keeps a host’s schedules safe', () => {
    // The slug prefix is the only thing distinguishing "a schedule Obsiddy owns"
    // from "a schedule the host owns" in a shared table.
    for (const workflow of OBSIDDY_WORKFLOWS) {
      expect(workflow.slug.startsWith(OBSIDDY_WORKFLOW_SLUG_PREFIX), workflow.slug).toBe(true);
    }
  });

  it('caps the cost of every workflow', () => {
    for (const workflow of OBSIDDY_WORKFLOWS) {
      expect(workflow.maxCostPerExecutionUsd, workflow.slug).toBeGreaterThan(0);
    }
  });
});

describe.each(OBSIDDY_WORKFLOWS.map((w) => [w.slug, w] as const))('%s', (slug, workflow) => {
  const steps = workflow.definition.steps;
  const ids = new Set(steps.map((step) => step.id));

  it('parses against the real engine schema', () => {
    const result = workflowDefinitionSchema.safeParse(workflow.definition);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it('has a resolvable entry step', () => {
    expect(ids.has(workflow.definition.entryStepId)).toBe(true);
  });

  it('has unique step ids', () => {
    expect(ids.size).toBe(steps.length);
  });

  it('points every edge at a step that exists', () => {
    for (const step of steps) {
      for (const edge of step.nextSteps ?? []) {
        expect(ids.has(edge.targetStepId), `${step.id} -> ${edge.targetStepId}`).toBe(true);
      }
    }
  });

  it('leaves no step unreachable from the entry point', () => {
    // An orphaned step is dead config that reads as working machinery.
    const seen = new Set<string>();
    const queue = [workflow.definition.entryStepId];
    while (queue.length > 0) {
      const id = queue.shift();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const step = steps.find((s) => s.id === id);
      for (const edge of step?.nextSteps ?? []) queue.push(edge.targetStepId);
    }
    expect([...ids].filter((id) => !seen.has(id))).toEqual([]);
  });

  it('names only capabilities that exist in the catalogue', () => {
    for (const step of steps) {
      if (step.type !== 'tool_call') continue;
      const capabilitySlug = (step.config as { capabilitySlug?: string }).capabilitySlug;
      expect(capabilitySlug, `${step.id} has no capabilitySlug`).toBeTruthy();
      expect(CAPABILITY_SLUGS.has(capabilitySlug as string), `${step.id}: ${capabilitySlug}`).toBe(
        true
      );
    }
  });

  it('names only agents that exist', () => {
    for (const step of steps) {
      if (step.type === 'agent_call') {
        const agentSlug = (step.config as { agentSlug?: string }).agentSlug;
        expect(AGENT_SLUGS.has(agentSlug as string), `${step.id}: ${agentSlug}`).toBe(true);
      }
      if (step.type === 'judge_call') {
        const judgeSlug = (step.config as { judgeAgentSlug?: string }).judgeAgentSlug;
        expect(AGENT_SLUGS.has(judgeSlug as string), `${step.id}: ${judgeSlug}`).toBe(true);
      }
    }
  });

  it('carries no user id in any step config', () => {
    // The owner travels on `execution.userId`. A userId here would be a second
    // path to the same thing — and the one a model could influence.
    const serialised = JSON.stringify(workflow.definition);
    expect(serialised).not.toMatch(/"userId"/);
  });

  it('lets a step that must receive run input declare no `args`', () => {
    // `tool-call.ts` resolves `config.args` → `config.argsFrom` → `ctx.inputData`,
    // and **`{}` is truthy** — so `args: {}` pins the arguments to empty and the
    // step never sees `inputData`. That silently broke "surprise me today": the
    // regenerate route queued the run with `{ workStyleOverride }`, the step
    // ignored it, and a briefing was written in the stored style with nothing
    // erroring. Any step meant to receive per-run input must omit `args`
    // entirely, not set it empty.
    for (const step of steps) {
      if (step.type !== 'tool_call') continue;
      const config = step.config as { capabilitySlug?: string; args?: unknown };
      if (config.capabilitySlug !== 'obsiddy_get_briefing_inputs') continue;
      expect(config.args, `${slug}/${step.id} must not pin empty args`).toBeUndefined();
    }
  });

  it('uses neither `route` nor `report` — both were corrected out of the plan', () => {
    // `route` is an LLM classifier (it would spend a model call reading a column
    // we can select); `report` renders the execution trace, not domain facts.
    // Asserted so a later edit does not reintroduce either by reading §6 alone.
    for (const step of steps) {
      expect(step.type, `${slug}/${step.id}`).not.toBe('route');
      expect(step.type, `${slug}/${step.id}`).not.toBe('report');
    }
  });
});
