/**
 * Attribute key constants for the tracer interface.
 *
 * Two namespaces:
 * - `gen_ai.*` — OpenTelemetry GenAI semantic conventions. These align with
 *   the OTEL spec so any OTLP-compatible backend (Datadog, Honeycomb,
 *   Grafana Tempo, Langfuse-via-OTLP) renders Resparkable spans correctly
 *   without custom mapping.
 * - `resparkable.*` — Resparkable-specific extensions for cost, agent, workflow,
 *   capability, and conversation correlation. Always lower-case dot-namespaced.
 */

// --- GenAI semantic conventions (subset Resparkable emits) ---

export const GEN_AI_SYSTEM = 'gen_ai.system';
export const GEN_AI_REQUEST_MODEL = 'gen_ai.request.model';
export const GEN_AI_RESPONSE_MODEL = 'gen_ai.response.model';
export const GEN_AI_REQUEST_TEMPERATURE = 'gen_ai.request.temperature';
export const GEN_AI_REQUEST_MAX_TOKENS = 'gen_ai.request.max_tokens';
export const GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens';
export const GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';
export const GEN_AI_USAGE_TOTAL_TOKENS = 'gen_ai.usage.total_tokens';
/** One of: 'chat' | 'tool_call' | 'embedding' | 'summary' | 'evaluation'. */
export const GEN_AI_OPERATION_NAME = 'gen_ai.operation.name';
/** Opt-in only. Never set unless `RESPARKABLE_OTEL_RECORD_PROMPTS=true`. */
export const GEN_AI_PROMPT = 'gen_ai.prompt';
/** Opt-in only. Never set unless `RESPARKABLE_OTEL_RECORD_PROMPTS=true`. */
export const GEN_AI_COMPLETION = 'gen_ai.completion';
export const GEN_AI_TOOL_NAME = 'gen_ai.tool.name';
export const GEN_AI_TOOL_CALL_ID = 'gen_ai.tool.call.id';

// --- Resparkable-specific extensions ---

export const RESPARKABLE_EXECUTION_ID = 'resparkable.execution_id';
export const RESPARKABLE_WORKFLOW_ID = 'resparkable.workflow_id';
export const RESPARKABLE_STEP_ID = 'resparkable.step_id';
export const RESPARKABLE_STEP_TYPE = 'resparkable.step_type';
export const RESPARKABLE_AGENT_ID = 'resparkable.agent_id';
export const RESPARKABLE_AGENT_SLUG = 'resparkable.agent_slug';
export const RESPARKABLE_CONVERSATION_ID = 'resparkable.conversation_id';
export const RESPARKABLE_CAPABILITY_SLUG = 'resparkable.capability';
export const RESPARKABLE_CAPABILITY_SUCCESS = 'resparkable.capability.success';
export const RESPARKABLE_USER_ID = 'resparkable.user_id';
export const RESPARKABLE_COST_USD = 'resparkable.cost_usd';
export const RESPARKABLE_TOOL_ITERATION = 'resparkable.tool_iteration';
export const RESPARKABLE_PROVIDER_FAILOVER_FROM = 'resparkable.provider.failover_from';
export const RESPARKABLE_PROVIDER_FAILOVER_TO = 'resparkable.provider.failover_to';
export const RESPARKABLE_STEP_LLM_DURATION_MS = 'resparkable.step.llm_duration_ms';
export const RESPARKABLE_EVALUATION_PHASE = 'resparkable.evaluation.phase';

// --- Span name constants ---

export const SPAN_WORKFLOW_EXECUTE = 'workflow.execute';
export const SPAN_WORKFLOW_STEP = 'workflow.step';
export const SPAN_LLM_CALL = 'llm.call';
export const SPAN_AGENT_CALL_TURN = 'agent_call.turn';
export const SPAN_CAPABILITY_DISPATCH = 'capability.dispatch';
export const SPAN_CHAT_TURN = 'chat.turn';
export const SPAN_TOOL_LOOP_ITERATION = 'chat.tool_loop_iteration';

/** Maximum length for any string attribute value. Strings beyond this are truncated at the wrap boundary. */
export const MAX_ATTRIBUTE_STRING_LENGTH = 1024;
