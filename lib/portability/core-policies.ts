/**
 * Transfer policy for the core and orchestration tables.
 *
 * The brain's own tables are classified one tier down, in
 * `lib/framework/resparkable/transfer/policy.ts`; a fork's are in
 * `lib/app/data-transfer.ts`. This file covers everything else — auth, agents,
 * workflows, knowledge, evaluations, MCP, and the platform's own bookkeeping.
 *
 * ## Three recurring decisions, made once here
 *
 * **Credentials never move.** Sessions, OAuth tokens, password hashes and API
 * key hashes are `skip`. A key hash is not a record *about* a key — it is the
 * thing the server compares against, so importing one would make the old key
 * work in the new environment. That is the difference between exporting a
 * password and exporting the ability to log in.
 *
 * **Anything that can act on its own arrives switched off.** Webhooks, event
 * hooks, schedules and triggers transfer, but with their secrets cleared and
 * their enabled flags forced false. This generalises the rule the orchestration
 * backup importer already applies to webhooks: a bundle should never be able to
 * start making outbound requests from an account the moment it lands.
 *
 * **History is `export-only`.** Executions, runs, audit logs and cost records go
 * into the bundle — they are the user's record and they are owed it — but they
 * are never written back. Re-importing them would manufacture provenance:
 * an execution trace in a new environment describing a run that never happened
 * there, sitting alongside real ones and indistinguishable from them.
 *
 * @see lib/portability/policy.ts — what each field means
 * @see lib/privacy/export-sources.ts — the Art. 15 manifest this deliberately differs from
 */

import type { TransferPolicySet } from '@/lib/portability/policy';

/** Shorthand for the many orchestration tables that are org config, not history. */
const AUTOMATION = { owner: 'core', group: 'automation' } as const;
const HISTORY = { owner: 'core', group: 'history' } as const;
const CONVERSATIONS = { owner: 'core', group: 'conversations' } as const;

export const corePolicies: TransferPolicySet = {
  policies: [
    // ───────────────────────────── account ─────────────────────────────

    {
      model: 'User',
      owner: 'core',
      group: 'account',
      disposition: 'transfer',
      note: 'Your profile: name, bio, contact details, timezone and preferences.',
      // The owner column IS the primary key here, which is what makes an import
      // land on the account doing the importing rather than creating a person.
      ownerColumn: 'id',
      mergeKeys: [['id']],
      // Identity and privilege are supplied by the target, never by a bundle.
      // Without this, an "overwrite on conflict" import would be a one-file
      // privilege escalation: hand-edit `role` to `admin`, import your own
      // bundle, done.
      regenerate: ['email', 'emailVerified', 'role', 'accountType', 'image'],
      jsonOpaque: {
        preferences:
          'Notification and display settings — booleans, locale strings and ' +
          'digest frequencies. Holds no row ids.',
      },
    },

    {
      model: 'Account',
      owner: 'core',
      group: 'account',
      disposition: 'skip',
      note:
        'Password hashes and OAuth access/refresh tokens. Importing these would ' +
        'transplant the ability to sign in, not a record of having signed in.',
    },
    {
      model: 'Session',
      owner: 'core',
      group: 'account',
      disposition: 'skip',
      note:
        'Live sign-in sessions. The Art. 15 export includes these minus the token ' +
        'so a person can see where they are signed in; transferring one is ' +
        'meaningless at best and account takeover at worst.',
    },
    {
      model: 'Verification',
      owner: 'core',
      group: 'account',
      disposition: 'skip',
      note:
        'Short-lived email and password-reset challenge values. Live credentials ' +
        'with minutes of validity; the Art. 15 manifest excludes them too.',
    },
    {
      model: 'AiApiKey',
      owner: 'core',
      group: 'account',
      disposition: 'skip',
      note:
        'Personal API keys. `keyHash` is the value the server authenticates ' +
        'against, so importing it would make the old key work here.',
    },

    // ─────────────────────────── conversations ──────────────────────────

    {
      ...CONVERSATIONS,
      model: 'AiConversation',
      disposition: 'transfer',
      note: 'Your chat conversations with agents, including the channel they arrived on.',
      ownerColumn: 'userId',
      softRefs: [
        {
          idColumn: 'summaryUpToMessageId',
          model: 'AiMessage',
          onUnresolved: 'null',
        },
      ],
      softRefsIgnored: {
        contextId:
          'Caller-supplied correlation id from the embedding page or inbound ' +
          'adapter. Opaque to us and meaningless outside its origin.',
      },
      jsonOpaque: {
        metadata:
          'Channel details — user agent, locale, referring page. No row ids; ' +
          'the id-shaped-string canary re-checks this against real data on every dry run.',
      },
      // `[agentId, channel, fromAddress]` is real, but `fromAddress` is null for
      // web chat, and Postgres treats nulls as distinct — so it does not bind
      // for the common case. Left off deliberately rather than relied on.
    },
    {
      ...CONVERSATIONS,
      model: 'AiMessage',
      disposition: 'transfer',
      note: 'The messages in those conversations, with their tool calls and citations.',
      softRefs: [
        { idColumn: 'agentVersionId', model: 'AiAgentVersion', onUnresolved: 'null' },
        { idColumn: 'workflowVersionId', model: 'AiWorkflowVersion', onUnresolved: 'null' },
        { idColumn: 'workflowExecutionId', model: 'AiWorkflowExecution', onUnresolved: 'null' },
      ],
      softRefsIgnored: {
        toolCallId: "The provider's own id for a tool call within one completion. Not our row.",
        modelId: "The provider's model identifier, e.g. `claude-opus-5`. A name, not a reference.",
      },
      jsonOpaque: {
        metadata: 'Token counts, latency, finish reason. Numbers and short strings.',
        provenance:
          'Which knowledge chunks grounded the answer, by chunk key and score. ' +
          'Chunk keys are content-addressed and stable across environments, so ' +
          'they are not remapped.',
      },
    },
    {
      ...CONVERSATIONS,
      model: 'AiUserMemory',
      disposition: 'transfer',
      note: 'Facts an agent remembered about you between conversations.',
      ownerColumn: 'userId',
      mergeKeys: [['userId', 'agentId', 'key']],
      secretReviewed: {
        key:
          'The name of the remembered fact — "preferred_name", "timezone". Part ' +
          'of this table’s natural key, not credential material.',
      },
    },
    {
      ...CONVERSATIONS,
      model: 'AiOutboundMessage',
      disposition: 'export-only',
      note:
        'Messages the system sent you over SMS or email. A delivery record tied ' +
        "to this environment's provider; replaying it elsewhere would claim sends that never happened.",
      softRefsIgnored: {
        transactionId: "The delivery provider's own id. Belongs to their system, not ours.",
      },
      secretReviewed: {
        dedupKey:
          'A deterministic hash of the message content and recipient, used to ' +
          'stop the same notification being sent twice. Not credential material.',
      },
    },
    {
      model: 'AiConversationShare',
      owner: 'core',
      group: 'conversations',
      disposition: 'skip',
      note:
        'Public share links for conversations. A share row IS the published link; ' +
        'recreating it elsewhere would republish content the new owner never chose to share.',
    },
    {
      model: 'AiMessageEmbedding',
      owner: 'core',
      group: 'conversations',
      disposition: 'skip',
      note:
        'Search vectors derived from messages that are exported in full. They ' +
        'carry no information the messages do not, and the vector column cannot ' +
        'be read through Prisma in any case.',
    },

    // ───────────────────────────── automation ───────────────────────────

    {
      ...AUTOMATION,
      model: 'AiAgent',
      disposition: 'transfer',
      note: 'Agents you configured: their instructions, model settings and tools.',
      ownerColumn: 'createdBy',
      mergeKeys: [['slug']],
      jsonOpaque: {
        systemInstructionsHistory: 'Previous instruction texts with timestamps.',
        providerConfig: 'Temperature, token limits, provider-specific switches.',
        metadata: 'Free-form labels set by an operator.',
        widgetConfig: 'Embedded-widget colours, greeting and placement.',
      },
      secretReviewed: {
        knowledgeTriggerKeywords:
          'A comma-separated list of words that make the agent search its ' +
          'knowledge base. Configuration the operator typed, not a credential.',
      },
    },
    {
      ...AUTOMATION,
      model: 'AiAgentProfile',
      disposition: 'transfer',
      note: 'Shared persona, voice and guardrail presets that agents inherit from.',
      ownerColumn: 'createdBy',
      mergeKeys: [['slug']],
    },
    {
      ...AUTOMATION,
      model: 'AiAgentVersion',
      disposition: 'transfer',
      note: 'Published versions of each agent, so its history survives the move.',
      ownerColumn: 'createdBy',
      mergeKeys: [['agentId', 'version']],
      jsonOpaque: {
        snapshot:
          'A frozen copy of the agent config at publish time. Field-for-field ' +
          'the agent columns, which are themselves id-free.',
      },
    },
    {
      ...AUTOMATION,
      model: 'AiCapability',
      // Installation-level, not personal: this table has no `createdBy` at all,
      // so there is no column that could scope it to one person, and the code
      // that actually implements a capability lives in the registry rather than
      // the database — a row without its class is inert. Moving these between
      // environments is the admin backup's job.
      disposition: 'export-only',
      note: 'The tool definitions your agents were allowed to call.',
      mergeKeys: [['slug']],
      jsonOpaque: {
        functionDefinition: 'JSON Schema for the tool arguments.',
        executionConfig: 'Endpoint, method and timeout for the handler.',
        metadata: 'Categorisation and display hints.',
      },
    },
    {
      ...AUTOMATION,
      model: 'AiAgentCapability',
      // A grant pointing at a capability that did not travel is not a grant.
      disposition: 'export-only',
      note: 'Which tools each of your agents was allowed to use.',
      mergeKeys: [['agentId', 'capabilityId']],
      jsonOpaque: { customConfig: 'Per-agent overrides of the tool defaults.' },
    },
    {
      ...AUTOMATION,
      model: 'AiWorkflow',
      disposition: 'transfer',
      note: 'Multi-step workflows you built.',
      ownerColumn: 'createdBy',
      mergeKeys: [['slug']],
      jsonOpaque: {
        draftDefinition: 'The unpublished step graph. Step ids are workflow-local.',
        metadata: 'Display and categorisation hints.',
      },
    },
    {
      ...AUTOMATION,
      model: 'AiWorkflowVersion',
      disposition: 'transfer',
      note: 'Published workflow versions.',
      ownerColumn: 'createdBy',
      mergeKeys: [['workflowId', 'version']],
      jsonOpaque: {
        snapshot: 'The frozen step graph. Step ids are local to the definition.',
      },
    },
    {
      ...AUTOMATION,
      model: 'AiWorkflowSchedule',
      disposition: 'transfer',
      note: 'Cron schedules for your workflows. They arrive switched off.',
      ownerColumn: 'createdBy',
      // Never let a bundle start running things on a timer the moment it lands.
      reset: { isEnabled: false, lastRunAt: null, nextRunAt: null },
      jsonOpaque: {
        inputTemplate: 'The payload template the run starts from.',
        scope: 'Owner routing for the run. Rewritten to the importing user.',
      },
    },
    {
      ...AUTOMATION,
      model: 'AiWorkflowTrigger',
      disposition: 'transfer',
      note: 'Inbound triggers for your workflows. They arrive switched off, without their signing secret.',
      ownerColumn: 'createdBy',
      mergeKeys: [['channel', 'workflowId']],
      regenerate: ['signingSecret'],
      reset: { isEnabled: false, lastFiredAt: null },
      jsonOpaque: {
        metadata: 'Channel configuration — allowed senders, parsing options.',
        scope: 'Owner routing. Rewritten to the importing user.',
      },
    },
    {
      ...AUTOMATION,
      model: 'AiEventHook',
      disposition: 'transfer',
      note: 'Event handlers you configured. They arrive disabled, without their secret.',
      ownerColumn: 'createdBy',
      regenerate: ['secret'],
      reset: { isEnabled: false },
      jsonOpaque: {
        action: 'What to do when the event fires — a URL or an internal handler name.',
        filter: 'Match conditions on the event payload.',
      },
    },
    {
      ...AUTOMATION,
      model: 'AiWebhookSubscription',
      disposition: 'transfer',
      note: 'Outbound webhooks you configured. They arrive inactive, without their secret.',
      ownerColumn: 'createdBy',
      regenerate: ['secret'],
      reset: { isActive: false },
    },
    {
      ...AUTOMATION,
      model: 'AiExperiment',
      disposition: 'transfer',
      note: 'A/B experiments you set up.',
      ownerColumn: 'createdBy',
      jsonOpaque: {
        metricConfigs: 'Which metrics to score and their thresholds.',
        pairwiseVerdict: 'Judge output comparing two variants. Prose and scores.',
      },
    },
    {
      ...AUTOMATION,
      model: 'AiExperimentVariant',
      disposition: 'transfer',
      note: 'The variants under each experiment.',
      softRefs: [{ idColumn: 'agentVersionId', model: 'AiAgentVersion', onUnresolved: 'null' }],
    },
    {
      ...AUTOMATION,
      model: 'AiDataset',
      disposition: 'transfer',
      note: 'Evaluation datasets you built.',
      ownerColumn: 'userId',
      secretReviewed: {
        contentHash:
          'A digest of the dataset’s cases, used to tell whether a run scored ' +
          'the version of the data it claims to have. Derived, not secret.',
      },
    },
    {
      ...AUTOMATION,
      model: 'AiDatasetCase',
      disposition: 'transfer',
      note: 'The individual test cases in those datasets.',
      mergeKeys: [['datasetId', 'position']],
      jsonOpaque: {
        input: 'The prompt or payload under test.',
        referenceCitations: 'Expected source citations, by chunk key.',
        metadata: 'Tags and notes on the case.',
      },
    },

    // ───────────────────────── knowledge (shared) ───────────────────────

    {
      ...AUTOMATION,
      model: 'AiKnowledgeBase',
      disposition: 'export-only',
      note:
        'Knowledge bases. These are an organisation-wide asset rather than ' +
        'personal data — moving one between environments is an operator job, and ' +
        'the admin backup at Settings → Backup is the tool for it.',
    },
    {
      ...AUTOMATION,
      model: 'AiKnowledgeDocument',
      disposition: 'export-only',
      note: 'Documents in the shared knowledge base, including ones you uploaded.',
      ownerColumn: 'uploadedBy',
      secretReviewed: {
        fileHash: 'A SHA-256 digest of the uploaded file, used for de-duplication.',
      },
      jsonOpaque: { metadata: 'Parser output — page count, detected language, headings.' },
    },
    {
      ...AUTOMATION,
      model: 'KnowledgeTag',
      disposition: 'export-only',
      note: 'Tags scoping which agents may read which documents.',
    },
    {
      ...AUTOMATION,
      model: 'AiKnowledgeDocumentTag',
      disposition: 'export-only',
      note: 'Which tags are on which shared documents.',
      mergeKeys: [['documentId', 'tagId']],
    },
    {
      ...AUTOMATION,
      model: 'AiAgentKnowledgeDocument',
      disposition: 'export-only',
      note: 'Per-agent grants over individual shared documents.',
      mergeKeys: [['agentId', 'documentId']],
    },
    {
      ...AUTOMATION,
      model: 'AiAgentKnowledgeTag',
      disposition: 'export-only',
      note: 'Per-agent grants over tagged sets of shared documents.',
      mergeKeys: [['agentId', 'tagId']],
    },
    {
      model: 'AiKnowledgeChunk',
      owner: 'core',
      group: 'automation',
      disposition: 'skip',
      note:
        'Text chunks and their search vectors, derived from documents. The vector ' +
        'columns cannot be read through Prisma, and the text is reproducible by ' +
        're-ingesting the document.',
    },

    // ──────────────────────── providers and MCP ─────────────────────────

    {
      ...AUTOMATION,
      model: 'AiProviderConfig',
      disposition: 'export-only',
      note:
        'Model provider setup. Bound to this environment — credentials live in ' +
        'environment variables the bundle cannot and must not carry, so an ' +
        'imported provider would name keys that are not there.',
      ownerColumn: 'createdBy',
      jsonOpaque: { metadata: 'Display name, docs link, capability flags.' },
      secretReviewed: {
        apiKeyEnvVar:
          'The NAME of the environment variable holding this provider’s key — ' +
          '`ANTHROPIC_API_KEY`, not its value. The key itself never enters the ' +
          'database, which is why this column exists in this form.',
      },
    },
    {
      ...AUTOMATION,
      model: 'AiProviderModel',
      disposition: 'export-only',
      note: 'The models available from each provider, with their pricing and limits.',
      ownerColumn: 'createdBy',
      softRefsIgnored: {
        modelId:
          "The provider's own model identifier, e.g. `claude-opus-5`. A name, not a reference.",
      },
      jsonOpaque: { metadata: 'Context window, modality flags, deprecation notes.' },
    },
    {
      model: 'AiOrchestrationSettings',
      owner: 'core',
      group: 'automation',
      disposition: 'skip',
      note:
        'A single operator-owned settings row keyed by slug, not per-account. It ' +
        'describes the installation, so carrying it into another one would ' +
        "overwrite that operator's choices.",
    },
    {
      ...AUTOMATION,
      model: 'McpServerConfig',
      disposition: 'export-only',
      note: 'MCP server setup. Operator-owned and bound to this installation.',
    },
    {
      ...AUTOMATION,
      model: 'McpExposedTool',
      disposition: 'export-only',
      note: 'Which capabilities this installation exposes over MCP.',
      mergeKeys: [['capabilityId']],
    },
    {
      ...AUTOMATION,
      model: 'McpExposedPrompt',
      disposition: 'export-only',
      note: 'Prompts this installation exposes over MCP.',
      ownerColumn: 'createdBy',
      mergeKeys: [['name']],
      jsonOpaque: {
        argumentsSpec: 'Declared prompt arguments and their types.',
        completionsSpec: 'Autocomplete hints for those arguments.',
      },
    },
    {
      ...AUTOMATION,
      model: 'McpExposedResource',
      disposition: 'export-only',
      note: 'Resources this installation exposes over MCP.',
      mergeKeys: [['uri']],
      jsonOpaque: { handlerConfig: 'How the resource is resolved when requested.' },
    },
    {
      model: 'McpApiKey',
      owner: 'core',
      group: 'automation',
      disposition: 'skip',
      note:
        'MCP client keys. `keyHash` is the authentication material itself, so ' +
        'importing one would make the old key work in the new environment.',
    },
    {
      model: 'AiAgentEmbedToken',
      owner: 'core',
      group: 'automation',
      disposition: 'skip',
      note:
        'Bearer tokens that let a web page embed an agent without signing in. ' +
        'Live credentials, and the origin allow-list they are paired with does ' +
        'not apply in a different environment.',
    },
    {
      model: 'AiAgentInviteToken',
      owner: 'core',
      group: 'automation',
      disposition: 'skip',
      note: 'Bearer tokens granting access to a private agent. Live credentials.',
    },

    // ────────────────────────────── history ─────────────────────────────

    {
      ...HISTORY,
      model: 'AiWorkflowExecution',
      disposition: 'export-only',
      note:
        'Runs of your workflows, with their inputs, outputs and step traces. ' +
        'Exported because it is your record; never written back, because an ' +
        'inbound run stores the raw trigger payload verbatim — sender addresses, ' +
        'message bodies, attachments — and replanting that in a different ' +
        'environment would move third-party data nobody asked to move.',
      ownerColumn: 'userId',
      softRefsIgnored: {
        triggerExternalId:
          'The originating system’s own id for the message that started the run ' +
          '— a Slack timestamp, a Postmark message id. Not our row.',
      },
      jsonOpaque: {
        inputData: 'The payload the run started from.',
        outputData: 'What the run produced.',
        executionTrace: 'Per-step timings, token counts and errors.',
        supervisorReport: 'The post-hoc audit of the run, when one was configured.',
        scope: 'Owner routing recorded at dispatch time.',
      },
      // A lock held by whichever worker was executing this run. Meaningless
      // outside the process that took it, and there is no reason for it to sit
      // in a file on someone's laptop.
      redact: ['leaseToken'],
      secretReviewed: {
        dedupKey:
          'A caller-supplied idempotency key stopping the same trigger starting ' +
          'two runs. Not credential material.',
      },
    },
    {
      ...HISTORY,
      model: 'AiEvaluationSession',
      disposition: 'export-only',
      note: 'Interactive evaluation sessions you ran, and the notes you left on them.',
      ownerColumn: 'userId',
      jsonOpaque: {
        improvementSuggestions: 'Model-written suggestions from the session.',
        metricSummary: 'Aggregate scores per metric — metric names and numbers.',
        metadata: 'Session labels and grader settings chosen when it was created.',
      },
    },
    {
      ...HISTORY,
      model: 'AiEvaluationLog',
      disposition: 'export-only',
      note: 'Individual graded exchanges within an evaluation session.',
      jsonOpaque: {
        inputData: 'The prompt under evaluation.',
        outputData: 'The response produced.',
        tokenUsage: 'Token counts and cost.',
        metadata: 'Grader configuration for this entry.',
        judgeReasoning: "The judging model's written rationale.",
      },
    },
    {
      ...HISTORY,
      model: 'AiEvaluationRun',
      disposition: 'export-only',
      note: 'Batch evaluation runs over a dataset.',
      ownerColumn: 'userId',
      secretReviewed: {
        datasetContentHash:
          'A copy of the dataset digest taken when the run started, so a later ' +
          'edit to the dataset is detectable. Derived, not secret.',
      },
      jsonOpaque: {
        metricConfigs: 'Which metrics were scored.',
        subjectOutputSelector: 'How the answer was extracted from the subject.',
        progress: 'Live counters while the run was in flight.',
        summary: 'Final aggregate scores.',
        gateConfig: 'Pass/fail thresholds.',
      },
    },
    {
      ...HISTORY,
      model: 'AiEvaluationCaseResult',
      disposition: 'export-only',
      note: 'Per-case results within a batch evaluation run.',
      mergeKeys: [['runId', 'casePosition']],
      jsonOpaque: {
        subjectMetadata: 'What produced the answer — agent or workflow version.',
        metricScores: 'Score per metric, with the judge rationale.',
      },
    },
    {
      ...HISTORY,
      model: 'AiCostLog',
      disposition: 'export-only',
      note: 'What each model call cost, by provider and model.',
      softRefsIgnored: {
        traceId: 'OpenTelemetry trace id. Belongs to the tracing backend, not the database.',
        spanId: 'OpenTelemetry span id. Same.',
      },
      jsonOpaque: { metadata: 'Request shape — token counts, cache hits, latency.' },
    },
    {
      ...HISTORY,
      model: 'AiAdminAuditLog',
      disposition: 'export-only',
      note:
        'Administrative changes, with who made them. An audit log that could be ' +
        'written by importing a file would not be an audit log.',
      ownerColumn: 'userId',
      softRefsIgnored: {
        entityId:
          'Identifies the row an admin changed, across every admin-editable ' +
          'table. Retained verbatim so the log still reads correctly against ' +
          'the environment it describes.',
      },
      jsonOpaque: {
        changes: 'Before and after values for the edited fields.',
        metadata: 'Request context — IP and user agent, scrubbed on erasure.',
      },
    },
    {
      ...HISTORY,
      model: 'McpAuditLog',
      disposition: 'export-only',
      note: 'MCP tool calls made against this installation.',
      jsonOpaque: { requestParams: 'Arguments the caller supplied.' },
      secretReviewed: {
        apiKeyId:
          'The id of the key row that made the call, so an audit entry can be ' +
          'attributed. Not the key, and not its hash.',
      },
    },
  ],

  crossBoundaryEdges: [
    {
      model: 'AiMessage',
      column: 'workflowExecutionId',
      reason:
        'Names the workflow run a message came out of. Executions are ' +
        'export-only, so this is nulled on import — the message is the thing ' +
        'worth keeping, and the run that produced it is a footnote that would ' +
        'point at nothing in the new environment anyway.',
    },
    {
      model: 'AiExperimentVariant',
      column: 'evaluationRunId',
      reason:
        'Links a variant to the batch evaluation that scored it. Evaluation ' +
        'runs are export-only, so the variant transfers with its configuration ' +
        'and without its historical score.',
    },
    {
      model: 'AiExperimentVariant',
      column: 'evaluationSessionId',
      reason:
        'The interactive-session equivalent of the above, and export-only for ' +
        'the same reason. The variant is config worth moving; the session that ' +
        'graded it is a record of something that happened here.',
    },
  ],

  excluded: [
    {
      model: 'AiWorkflowStepDispatch',
      owner: 'core',
      reason:
        'In-flight dispatch records the engine uses to make step delivery ' +
        'idempotent. They are meaningful only to the running executor and are ' +
        'pruned once a run reaches a terminal state.',
    },
    {
      model: 'AiWorkflowRunningStep',
      owner: 'core',
      reason:
        'Live per-step state for executions currently running. Transient by ' +
        'construction; a copy would describe work no longer happening.',
    },
    {
      model: 'AiWorkflowExecutionLeaseEvent',
      owner: 'core',
      reason:
        'Lease acquire/renew/expire events used to detect stuck executions. ' +
        'Operational telemetry about this installation, not about a person.',
    },
    {
      model: 'AiWebhookDelivery',
      owner: 'core',
      reason:
        'Per-attempt delivery records with response codes and retry counts. They ' +
        'describe conversations between this installation and a third-party ' +
        'endpoint, and are pruned on a retention schedule.',
    },
    {
      model: 'AiEventHookDelivery',
      owner: 'core',
      reason:
        'The same, for internal event hooks. Transient dispatch bookkeeping with ' +
        'a retention window.',
    },
    {
      model: 'ContactSubmission',
      owner: 'core',
      reason:
        'Messages sent through the public contact form, matched by email address ' +
        'rather than account. They belong to the site inbox that received them, ' +
        'not to an account, so there is nothing to move. The Art. 15 export does ' +
        'include them, and that divergence is pinned by the coverage guard.',
    },
    {
      model: 'DataErasureReceipt',
      owner: 'core',
      reason:
        'Append-only proof that an erasure was carried out, deliberately holding ' +
        'no foreign key so it outlives the account. A receipt that could be ' +
        'created by importing a file would prove nothing.',
    },
    {
      model: 'FeatureFlag',
      owner: 'core',
      reason:
        'Rollout switches for this installation. Operator-owned, and importing ' +
        "them would change another operator's live configuration.",
    },
    {
      model: 'AuthBootstrap',
      owner: 'core',
      reason:
        'A single row recording whether first-run admin setup has happened. ' +
        'Describes the installation, and importing it could re-open or wrongly ' +
        'close the bootstrap window.',
    },
    {
      model: 'SeedHistory',
      owner: 'core',
      reason:
        'Which seed units have been applied to this database. Migration ' +
        'bookkeeping; importing it would make the target skip seeds it never ran.',
    },
  ],
};
