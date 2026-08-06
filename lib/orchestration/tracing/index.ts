/**
 * Orchestration tracing — vendor-neutral tracer interface with a no-op default
 * and an opt-in OpenTelemetry adapter.
 *
 * See `.context/orchestration/tracing.md` for the full guide.
 */

export type {
  Span,
  SpanAttributeValue,
  SpanAttributes,
  SpanKind,
  SpanStatus,
  SpanStatusCode,
  StartSpanOptions,
  Tracer,
} from '@/lib/orchestration/tracing/tracer';

export { NOOP_SPAN, NOOP_TRACER } from '@/lib/orchestration/tracing/noop-tracer';
export { getTracer, registerTracer } from '@/lib/orchestration/tracing/registry';
export {
  recordSpanException,
  setSpanAttributes,
  setSpanStatus,
  startManualSpan,
  truncateAttribute,
  withSpan,
  withSpanGenerator,
} from '@/lib/orchestration/tracing/with-span';
export { OtelTracer } from '@/lib/orchestration/tracing/otel-adapter';
export { registerOtelTracer } from '@/lib/orchestration/tracing/otel-bootstrap';

export {
  GEN_AI_COMPLETION,
  GEN_AI_OPERATION_NAME,
  GEN_AI_PROMPT,
  GEN_AI_REQUEST_MAX_TOKENS,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_REQUEST_TEMPERATURE,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_SYSTEM,
  GEN_AI_TOOL_CALL_ID,
  GEN_AI_TOOL_NAME,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_TOTAL_TOKENS,
  MAX_ATTRIBUTE_STRING_LENGTH,
  SPAN_AGENT_CALL_TURN,
  SPAN_CAPABILITY_DISPATCH,
  SPAN_CHAT_TURN,
  SPAN_LLM_CALL,
  SPAN_TOOL_LOOP_ITERATION,
  SPAN_WORKFLOW_EXECUTE,
  SPAN_WORKFLOW_STEP,
  RESPARKABLE_AGENT_ID,
  RESPARKABLE_AGENT_SLUG,
  RESPARKABLE_CAPABILITY_SLUG,
  RESPARKABLE_CAPABILITY_SUCCESS,
  RESPARKABLE_CONVERSATION_ID,
  RESPARKABLE_COST_USD,
  RESPARKABLE_EVALUATION_PHASE,
  RESPARKABLE_EXECUTION_ID,
  RESPARKABLE_PROVIDER_FAILOVER_FROM,
  RESPARKABLE_PROVIDER_FAILOVER_TO,
  RESPARKABLE_STEP_ID,
  RESPARKABLE_STEP_LLM_DURATION_MS,
  RESPARKABLE_STEP_TYPE,
  RESPARKABLE_TOOL_ITERATION,
  RESPARKABLE_USER_ID,
  RESPARKABLE_WORKFLOW_ID,
} from '@/lib/orchestration/tracing/attributes';
