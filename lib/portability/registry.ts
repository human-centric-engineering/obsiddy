/**
 * Every tier's transfer policy, assembled into one lookup.
 *
 * Three tiers contribute and the order is deliberate: core, then the Resparkable
 * framework tier, then the app seam. A later tier may not silently replace an
 * earlier one's entry — duplicates are a coverage-guard failure rather than a
 * last-write-wins merge, because "two files disagree about whether this table
 * transfers" is exactly the kind of question that should be settled by a human
 * reading a test failure.
 *
 * Static imports, not boot-time registration. `lib/app/data-export.ts` explains
 * the reasoning for its own seam and it applies here with more force: a policy
 * that failed to register would not throw, it would produce an export missing a
 * table and an import that silently skipped one.
 *
 * @see lib/portability/policy.ts — the vocabulary
 * @see lib/portability/core-policies.ts
 * @see lib/framework/resparkable/transfer/policy.ts
 * @see lib/app/data-transfer.ts
 */

import { appTransferPolicies } from '@/lib/app/data-transfer';
import { resparkableTransferPolicies } from '@/lib/framework/resparkable/transfer/policy';
import { corePolicies } from '@/lib/portability/core-policies';
import type {
  CrossBoundaryEdge,
  ExcludedModel,
  TransferGroup,
  TransferPolicy,
  TransferPolicySet,
} from '@/lib/portability/policy';

/** The tiers, in assembly order. Exported so the guard can report per-tier. */
export const POLICY_SETS: readonly TransferPolicySet[] = [
  corePolicies,
  resparkableTransferPolicies,
  appTransferPolicies,
];

/** Every declared policy, across every tier. */
export const TRANSFER_POLICIES: readonly TransferPolicy[] = POLICY_SETS.flatMap(
  (set) => set.policies
);

/** Every model deliberately left out, with its reason. */
export const TRANSFER_EXCLUDED: readonly ExcludedModel[] = POLICY_SETS.flatMap(
  (set) => set.excluded ?? []
);

/** Foreign keys that knowingly point at something which does not transfer. */
export const CROSS_BOUNDARY_EDGES: readonly CrossBoundaryEdge[] = POLICY_SETS.flatMap(
  (set) => set.crossBoundaryEdges ?? []
);

/**
 * Model name → policy.
 *
 * Built once. A duplicate model name would make this map lossy, so the coverage
 * guard checks for duplicates against {@link TRANSFER_POLICIES} rather than
 * against this map — by the time a value lands here, the collision is invisible.
 */
const POLICY_BY_MODEL = new Map(TRANSFER_POLICIES.map((policy) => [policy.model, policy]));

/** The policy for a model, or `undefined` if it has none. */
export function policyFor(model: string): TransferPolicy | undefined {
  return POLICY_BY_MODEL.get(model);
}

/** Models whose rows are both exported and written back on import. */
export function transferableModels(): TransferPolicy[] {
  return TRANSFER_POLICIES.filter((policy) => policy.disposition === 'transfer');
}

/** Models that appear in a bundle — everything except `skip`. */
export function exportableModels(): TransferPolicy[] {
  return TRANSFER_POLICIES.filter((policy) => policy.disposition !== 'skip');
}

/**
 * The groups a user can tick, in the order the export UI shows them.
 *
 * Listed explicitly rather than derived from the policies so the order is a
 * design decision rather than an accident of declaration order — and so a group
 * with no models yet still has a defined position.
 */
export const TRANSFER_GROUP_ORDER: readonly TransferGroup[] = [
  'account',
  'brain',
  'conversations',
  'automation',
  'history',
];

/** Human-facing labels for the export UI's checkboxes. */
export const TRANSFER_GROUP_LABELS: Readonly<Record<TransferGroup, string>> = {
  account: 'Account and profile',
  brain: 'Your brain',
  conversations: 'Conversations',
  automation: 'Agents and workflows',
  history: 'Activity history',
};

/** Every exportable model in one group. */
export function modelsInGroup(group: TransferGroup): TransferPolicy[] {
  return exportableModels().filter((policy) => policy.group === group);
}

/** One group, described well enough for somebody to decide whether to tick it. */
export interface TransferGroupSummary {
  group: TransferGroup;
  label: string;
  /** How many tables would be considered. */
  models: number;
  /**
   * The tables' own plain-English notes.
   *
   * Carried through rather than re-written for the UI, so the sentence a user
   * reads in the export dialog is the same sentence that governs the table —
   * there is no second description to drift.
   */
  notes: readonly string[];
}

/**
 * The groups, ready for the export UI.
 *
 * Computed here rather than in a component because the policy files are large
 * and server-only in spirit: a client component importing them would ship every
 * table's prose to the browser.
 */
export function transferGroupSummaries(): TransferGroupSummary[] {
  return TRANSFER_GROUP_ORDER.map((group) => {
    const models = modelsInGroup(group);
    return {
      group,
      label: TRANSFER_GROUP_LABELS[group],
      models: models.length,
      notes: models.map((policy) => policy.note),
    };
  });
}
