/**
 * The two task capabilities: `resparkable_list_tasks` and `resparkable_upsert_task`.
 *
 * Both go through `taskResource`, the descriptor the HTTP routes use, so an
 * agent-created task carries the same events, the same `completedAt` stamping
 * and the same project `lastActivityAt` bump as one created in the UI.
 *
 * **Neither can touch `manualBoost`.** The list tool returns it (a model that
 * cannot see a pin will keep proposing that the pinned task be deprioritised),
 * but the upsert schema `omit`s all three boost fields, so writing one is a type
 * error rather than a review note. The boost is the human's veto over the
 * machine's ranking; a machine that can set it has taken the veto away (§10).
 */

import { ResparkableCapability, maskFreeText } from '@/lib/framework/resparkable/capabilities/base';
import {
  resparkableCapabilitySpec,
  RESPARKABLE_CAPABILITY_SLUGS,
} from '@/lib/framework/resparkable/capabilities/catalogue';
import { runUpsert, type UpsertData } from '@/lib/framework/resparkable/capabilities/upsert';
import type { OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { taskResource } from '@/lib/framework/resparkable/services/resources';
import {
  agentListTasksSchema,
  agentUpsertTaskSchema,
  type AgentListTasksInput,
  type AgentUpsertTaskInput,
} from '@/lib/framework/resparkable/validations';
import type { ProvenanceRedaction } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';
import { redactedString } from '@/lib/security/redact';

// ─── List ────────────────────────────────────────────────────────────────────

const listSpec = resparkableCapabilitySpec(RESPARKABLE_CAPABILITY_SLUGS.listTasks);

interface ListedTask {
  id: string;
  title: string;
  status: string;
  projectId: string | null;
  dueAt: string | null;
  deferUntil: string | null;
  estimateMinutes: number | null;
  energy: string | null;
  /** The number the scorer wrote. The model reports it; it never produces one. */
  priorityScore: number;
  /** Which of the six factors dominated — the one-word "why is this first". */
  dominantFactor: string | null;
}

interface ListTasksData {
  tasks: ListedTask[];
  /** Total matching the filter, so a truncated page is visible rather than implied. */
  total: number;
}

/** Read the scorer's own explanation blob without trusting its shape (the column is `Json?`). */
function dominantFactorOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const dominant = (value as Record<string, unknown>).dominantFactor;
  return typeof dominant === 'string' ? dominant : null;
}

/** One row of `taskResource.list`, read defensively — the descriptor returns `unknown`. */
function toListedTask(row: unknown): ListedTask | null {
  if (typeof row !== 'object' || row === null) return null;
  const task = row as Record<string, unknown>;
  if (typeof task.id !== 'string' || typeof task.title !== 'string') return null;

  const iso = (value: unknown): string | null =>
    value instanceof Date ? value.toISOString() : null;

  return {
    id: task.id,
    title: task.title,
    status: typeof task.status === 'string' ? task.status : 'todo',
    projectId: typeof task.projectId === 'string' ? task.projectId : null,
    dueAt: iso(task.dueAt),
    deferUntil: iso(task.deferUntil),
    estimateMinutes: typeof task.estimateMinutes === 'number' ? task.estimateMinutes : null,
    energy: typeof task.energy === 'string' ? task.energy : null,
    priorityScore: typeof task.priorityScore === 'number' ? task.priorityScore : 0,
    dominantFactor: dominantFactorOf(task.priorityFactors),
  };
}

export class ResparkableListTasksCapability extends ResparkableCapability<
  AgentListTasksInput,
  ListTasksData
> {
  readonly slug = listSpec.slug;
  readonly functionDefinition: CapabilityFunctionDefinition = listSpec.functionDefinition;
  protected readonly schema = agentListTasksSchema;

  /**
   * The arguments are all structural — a status, a project id, two bounds — and
   * worth keeping verbatim. The results are task titles, which are prose about
   * the user's life ("call the clinic back", "draft the redundancy letter"), so
   * the audit row keeps ids and the count instead.
   */
  redactProvenance(
    args: AgentListTasksInput,
    result: CapabilityResult<ListTasksData>
  ): ProvenanceRedaction {
    const tasks = result.data?.tasks ?? [];
    return {
      args,
      resultPreview: JSON.stringify({
        success: result.success,
        returned: tasks.length,
        total: result.data?.total ?? 0,
        ids: tasks.map((task) => task.id),
      }),
    };
  }

  protected async run(
    args: AgentListTasksInput,
    scope: OwnerScope
  ): Promise<CapabilityResult<ListTasksData>> {
    const { items, total } = await taskResource.list(scope, {
      limit: args.limit,
      offset: 0,
      includeArchived: false,
      // The query schema's `hideDeferred` is non-optional after its transform —
      // an absent query param means `false` there, and it must mean the same
      // here, or the agent path would hide deferred tasks the web path shows.
      hideDeferred: args.hideDeferred ?? false,
      ...(args.status ? { status: args.status } : {}),
      ...(args.projectId ? { projectId: args.projectId } : {}),
    });

    const tasks = items.map(toListedTask).filter((task): task is ListedTask => task !== null);
    return this.success({ tasks, total });
  }
}

// ─── Upsert ──────────────────────────────────────────────────────────────────

const upsertSpec = resparkableCapabilitySpec(RESPARKABLE_CAPABILITY_SLUGS.upsertTask);

export class ResparkableUpsertTaskCapability extends ResparkableCapability<
  AgentUpsertTaskInput,
  UpsertData
> {
  readonly slug = upsertSpec.slug;
  readonly functionDefinition: CapabilityFunctionDefinition = upsertSpec.functionDefinition;
  protected readonly schema = agentUpsertTaskSchema;

  /** Title and notes are the user's own words; every other field is structure. */
  redactProvenance(
    args: AgentUpsertTaskInput,
    result: CapabilityResult<UpsertData>
  ): ProvenanceRedaction {
    return {
      args: maskFreeText(args, ['title', 'notes']),
      resultPreview: JSON.stringify({
        success: result.success,
        ...(result.data
          ? { id: result.data.id, action: result.data.action, label: redactedString('task title') }
          : { error: result.error }),
      }),
    };
  }

  protected async run(
    args: AgentUpsertTaskInput,
    scope: OwnerScope
  ): Promise<CapabilityResult<UpsertData>> {
    const outcome = await runUpsert(taskResource, scope, args, 'title');
    if (!outcome) return this.error('No task with that id.', 'not_found');
    return this.success(outcome);
  }
}
