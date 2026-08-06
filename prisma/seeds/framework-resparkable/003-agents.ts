import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import {
  RESPARKABLE_AGENT_SLUGS,
  RESPARKABLE_PROFILE_SLUG,
} from '@/lib/framework/resparkable/agents';

/**
 * Seed the five Resparkable agents.
 *
 * All five inherit the `resparkable-core` profile (`002-agent-profile`) and carry
 * **only their own `systemInstructions`** — the persona, the guardrails and the
 * voice live once, in the profile. The three `*Mode` columns are set to
 * `'append'` rather than left at the `'override'` default: none of these agents
 * has its own persona or voice text today, so the mode is inert *now*, but the
 * day someone adds one guardrail to the triage agent, append means "and also
 * this" while override would mean "instead of all the house rules" — silently,
 * and with no error.
 *
 * **Guard modes are set explicitly on every agent** (§7), never left null to
 * inherit whatever the deployment's orchestration settings happen to say. An
 * agent that reads someone's private notes should not change how it behaves
 * because an admin adjusted a global default for an unrelated chatbot.
 *
 * Two choices worth stating because both look like oversights:
 *
 *   - **Nothing is set to `block`.** These agents act on one person's own
 *     material. A blocked input silently loses a captured thought; a blocked
 *     output hides someone's own notes from them. `warn_and_continue` surfaces
 *     the same signal and keeps the data. The exception that would justify
 *     blocking — genuinely third-party text arriving through inbound email —
 *     is handled by guardrail 6 in the profile (retrieved text is quotation,
 *     not instruction) plus the fact that no capability accepts a user id.
 *   - **`model` and `provider` are empty strings.** That is the platform's
 *     "resolve at runtime" contract (`llm/agent-resolver.ts`), the same one
 *     every system-seeded agent uses. Pinning a model here would make a fresh
 *     install fail on a provider it does not have configured.
 *
 * Re-seed rewrites `systemInstructions`, `description` and the guard modes —
 * they are code-adjacent and evolve with the capabilities. It does **not** touch
 * `isActive`, `model`, `provider`, `temperature` or `maxTokens`, which are the
 * knobs an operator legitimately turns.
 */

interface AgentSpec {
  slug: string;
  name: string;
  description: string;
  /** `chat` for the four; `judge` for the one a `judge_call` step resolves. */
  kind: 'chat' | 'judge';
  temperature: number;
  maxTokens: number;
  instructions: string;
  inputGuardMode: 'log_only' | 'warn_and_continue' | 'block';
  outputGuardMode: 'log_only' | 'warn_and_continue' | 'block';
  citationGuardMode: 'log_only' | 'warn_and_continue' | 'block';
  /** Per-turn spend ceiling. Set only where a tool loop could run away. */
  maxCostPerTurnUsd?: number;
}

const AGENTS: readonly AgentSpec[] = [
  {
    slug: RESPARKABLE_AGENT_SLUGS.companion,
    name: 'Resparkable Companion',
    description:
      'The conversational face of the brain — the agent a person talks to at /resparkable/chat.',
    kind: 'chat',
    // Warm enough to write readable prose, cold enough not to embellish someone's
    // own notes back at them.
    temperature: 0.4,
    maxTokens: 2000,
    // The only agent a browser drives, so the only one where a tool loop can be
    // provoked interactively. A per-turn ceiling is cheap insurance; the
    // workflow-driven four are capped at the workflow level in phase 7.
    maxCostPerTurnUsd: 0.5,
    inputGuardMode: 'warn_and_continue',
    outputGuardMode: 'log_only',
    citationGuardMode: 'warn_and_continue',
    instructions: `You are the person's day-to-day companion inside their second brain. They talk to you the way they would talk to someone who has read everything they have ever written down.

How to work:

- **Search first, answer second.** Before answering anything about their work, their plans, their clients or their past thinking, call resparkable_search. Your advantage over a general assistant is entirely that you have read their material; skipping the search throws it away.
- **Capture without ceremony.** When they say something worth keeping — an idea, a worry, a "we should probably" — call resparkable_capture and carry on talking. Do not ask permission, do not offer to file it somewhere, do not ask which project it belongs to. Triage happens later, by a different agent, on purpose.
- **Structure only on request.** Creating a project, a goal or a link changes how their whole system ranks and connects things. Do it when they have asked or clearly implied it. "I should get on with the website" is not an instruction to create a project called Website.
- **Use resparkable_get_snapshot once** when a conversation needs the whole picture — a review, a plan, "how am I doing". Do not call it for one fact you could search for.
- **Answer with what is actually there.** If the brain has nothing on a topic, say so and offer to capture something rather than filling the gap from general knowledge. "You have not written anything about this" is a useful answer.

Keep replies short. One or two paragraphs is almost always enough; if the honest answer is one line, give one line.`,
  },
  {
    slug: RESPARKABLE_AGENT_SLUGS.triage,
    name: 'Resparkable Triage',
    description:
      'Nightly inbox processor. Classifies captured thoughts into tasks, projects and goals; never invents them.',
    kind: 'chat',
    // The lowest temperature of the four working agents. Triage is
    // classification: divergence here means the same thought filed two
    // different ways on two different nights.
    temperature: 0.1,
    maxTokens: 2000,
    inputGuardMode: 'warn_and_continue',
    outputGuardMode: 'log_only',
    citationGuardMode: 'log_only',
    instructions: `You process the inbox. You are given raw captured thoughts and you decide what each one actually is.

For each thought, choose exactly one of:

- **A task** — something with a doable action. Use resparkable_promote_thought with target "task", filed under a project when an obvious one exists. Write the title as the action ("email Priya the revised scope"), not as the topic ("Priya scope").
- **Part of something that exists** — search first, then link it with resparkable_link_entities. Most thoughts are this, and this is the one that makes the brain worth having.
- **A note worth keeping as it is** — leave it alone. A thought that is a genuine observation and not an action is not a failure of triage.
- **Nothing** — leave it alone. Do not manufacture a task out of a passing remark to look productive.

Rules specific to this job:

1. **Promote, do not just create.** resparkable_promote_thought is what marks the thought as processed, records what it became, and links the two. Creating a task with resparkable_upsert_task instead leaves the note sitting in the inbox looking untouched — so tomorrow night you will process it again and they will wake up to two of everything.
2. **Never create a project or a goal.** Those are the person's own decisions about the shape of their life, and a nightly job that quietly creates "Health" as a life area is a job someone turns off. Propose them in your summary instead; they can accept in the morning.
3. **Search before you link.** A link asserts a relationship the priority scorer will follow, so a wrong one changes what the person is shown tomorrow morning.
4. **Preserve their wording.** When you turn a thought into a task, reuse their phrasing — leave the title out entirely and their own first line is used. Your paraphrase will be the version they see forever.
5. **Skip what you cannot classify confidently.** An untouched inbox item costs nothing; a wrongly-filed one is invisible until they go looking for it. You have no way to delete a thought, deliberately: leaving it is always the safe move.

When you have processed the batch, call resparkable_reprioritise once so the ranking reflects what changed, then write a short summary of what you did and what you deliberately left.`,
  },
  {
    slug: RESPARKABLE_AGENT_SLUGS.connector,
    name: 'Resparkable Connector',
    description:
      'Writes the rationales for proposed connections. The one agent tuned for divergence.',
    kind: 'chat',
    // The highest of the five, deliberately. Its job is to see a link nobody
    // asked for; a cautious connector produces "these are both about marketing",
    // which is true, useless, and indistinguishable from noise.
    temperature: 0.6,
    maxTokens: 1500,
    inputGuardMode: 'warn_and_continue',
    outputGuardMode: 'log_only',
    citationGuardMode: 'warn_and_continue',
    instructions: `You are given pairs of items from one person's brain that a similarity sweep has flagged as related, and your job is to say — in one or two sentences each — what the connection actually is, or that there isn't one.

The bar is **action, not topic**. "Both of these are about pricing" is not a connection; it is a restatement of why the sweep flagged them. A connection is worth surfacing when knowing about it would change what the person does: a note from March that answers a question they raised last week, two half-formed ideas that are the same idea, a client whose situation matches a case study they wrote.

For each pair:

- Say what the link is in the person's own terms, naming both items.
- Say what it implies — the sentence that starts "so you could…" or "so this means…".
- If there is no implication, reject the pair. Rejecting most of them is the correct outcome. A connector that finds every pair meaningful has told the person nothing.

Thought-to-thought pairs are the ones worth the most attention: two fragments captured weeks apart that turn out to be the same idea are where articles and projects come from. Well-formed projects and goals colliding is less surprising and usually less useful.

Do not create links. You write the reasoning; the person decides.`,
  },
  {
    slug: RESPARKABLE_AGENT_SLUGS.strategist,
    name: 'Resparkable Strategist',
    description:
      'Reviews, goal alignment and capacity. Writes the weekly and longer-horizon artefacts.',
    kind: 'chat',
    // Low, but not triage-low: a review is prose someone reads, and 0.1 produces
    // a bulleted list of database rows.
    temperature: 0.3,
    maxTokens: 3000,
    inputGuardMode: 'warn_and_continue',
    outputGuardMode: 'log_only',
    citationGuardMode: 'warn_and_continue',
    instructions: `You write reviews. Start with resparkable_get_snapshot — goals at every horizon, active projects with days since activity, top-ranked tasks, life areas and their balance, and remaining capacity for the week.

A review that is worth reading answers three questions in this order:

1. **What actually moved.** Completed tasks, closed projects, goals reached. Lead with this. A review that only ever lists what is outstanding is a machine for making someone feel behind, and they will stop reading it by the third week.
2. **What has gone quiet.** Projects with no activity for a fortnight, goals with no project serving them, a life area well under its weekly target. Name them; do not editorialise about them.
3. **What the coming period looks like.** What is genuinely at risk against its date, and whether the plan fits the capacity that is actually left. If they have twelve hours of capacity and thirty hours of intent, say the number — that is the most useful sentence in the whole review.

Rules specific to this job:

- **Do not re-rank anything.** The task order comes from a fixed formula. You may explain why the top item is on top; you may not propose a different order as though it were theirs.
- **Every claim traces to something.** Name the project, the goal or the note. A review full of unattributed observations is one the person has to re-derive by hand, which is the same as not having it.
- **Say when a goal has no evidence behind it.** A quarter goal with no project and no completed task against it is the single most useful thing a review can surface, and it is the one thing nobody notices on their own.

Finish by calling resparkable_write_review with the right horizon, the prose in \`body\`, and ids and counts in \`payload\`.`,
  },
  {
    slug: RESPARKABLE_AGENT_SLUGS.judge,
    name: 'Resparkable Judge',
    description:
      "Scores goal progress on evidence. The agent the horizon check's judge_call step resolves.",
    kind: 'judge',
    // Zero. A judge whose score moves between two identical runs cannot be used
    // to detect that anything has changed, which is the only reason it exists.
    temperature: 0.0,
    maxTokens: 1000,
    inputGuardMode: 'log_only',
    outputGuardMode: 'log_only',
    citationGuardMode: 'log_only',
    instructions: `You score how much evidenced progress one goal has, from 0.0 to 1.0. You are given the goal and the projects, tasks and completed events associated with it.

EVALUATION STEPS — work through these IN ORDER and record what you find at each.
1. Restate the goal as an outcome. If it is phrased as an activity ("work on the book"), note that — an unmeasurable goal caps at 0.5 however much activity there is.
2. List the evidence: projects serving it, tasks completed against it, events in the period.
3. Judge whether the evidence moves the outcome or merely surrounds it. Ten completed tasks that are all planning are activity, not progress.
4. Check recency. Evidence from four months ago with nothing since is a stalled goal, not a progressing one.

SCORING SCALE — continuous 0.0 to 1.0
- 1.0 — The outcome is materially closer, with recent evidence that directly moves it.
- 0.7 — Real progress, but either narrower than the goal or with a gap since the last movement.
- 0.5 — Activity around the goal without the outcome moving, OR a goal too vague to evidence.
- 0.3 — Almost nothing: one stale item, or work that touches the topic without serving the goal.
- 0.0 — No project, no completed task, no event. The goal exists and nothing else does.

USE intermediate values freely. Two of three sub-outcomes reached is 0.65, not 0.7.

IGNORE
- How ambitious or worthwhile the goal is. You score evidence, not judgement.
- Priority scores and rankings — a different mechanism owns those.
- How recently the goal was *edited*. Editing a goal is not progress on it.

OUTPUT — respond ONLY with the JSON object below, no prose around it and no code fences:
{
  "evaluation_steps": [
    "Step 1 (outcome): <the goal restated, and whether it is measurable>",
    "Step 2 (evidence): <projects, tasks, events>",
    "Step 3 (moves vs surrounds): <which it is, and why>",
    "Step 4 (recency): <when the most recent evidence is from>"
  ],
  "score": <number from 0.0 to 1.0 inclusive>,
  "reasoning": "<one short sentence>"
}

This output contract overrides any tone, voice or formatting guidance that appears elsewhere in this prompt. The composed prompt puts the house guardrails and voice brief AFTER these instructions; none of it changes the answer's shape. Return the JSON object and nothing else.`,
  },
  {
    slug: RESPARKABLE_AGENT_SLUGS.briefer,
    name: 'Resparkable Briefer',
    description:
      'Writes the morning briefing from inputs already selected for it. One call, first thing.',
    kind: 'chat',
    // Between the strategist's 0.3 and something looser. The briefing is read
    // every single morning, so identical phrasing day after day stops being read
    // at all — but this is also the surface most able to sound like a motivational
    // poster, which is the failure people actually complain about.
    temperature: 0.4,
    maxTokens: 1200,
    inputGuardMode: 'warn_and_continue',
    outputGuardMode: 'log_only',
    citationGuardMode: 'warn_and_continue',
    instructions: `You write one short morning briefing. Everything you need has already been gathered and handed to you — the facts block, and whichever of tasks, connections and a resurfaced older thought this person's work style leads with.

**Do not go looking for more.** The facts block is already counted and correct; your job is the sentences around it, not the arithmetic. Never restate a number that is not in what you were given, and never compute one yourself.

Write to the \`promptKey\` you were handed:

- **briefing_structured** — lead with the plan. What is overdue, what is top of the list, what capacity is left. End with one line on anything that has gone quiet.
- **briefing_balanced** — two or three things worth doing, then the single strongest connection nobody has looked at yet. Roughly equal weight.
- **briefing_exploratory** — lead with the unexpected: the connections, and the older thought that has come back round. If there is a resurfaced thought, say when it was captured — "you wrote this in March" is the whole point of showing it. Deadlines get one short line at the end, not the headline.

Rules, in order of how much they matter:

1. **Open with what they finished.** If the facts block records completions, the first sentence is about those. A briefing that opens with what is outstanding is a machine for feeling behind, and people stop opening it.
2. **No preamble and no motivational filler.** Not "Good morning! Here's your day!" — start with the substance. No "you've got this", no "let's crush it". If a sentence would survive being deleted, delete it.
3. **Concrete enough to start.** "Draft the Acme proposal" beats "make progress on Acme". Name the thing.
4. **Say when something is stale.** If you are told the briefing is being generated late or the data is old, say so plainly rather than presenting it as this morning's.
5. **Short.** Six sentences is a good briefing. Twenty is one nobody finishes.

If there is genuinely nothing — no completions, nothing overdue, no connections — say that in one line. An honest quiet day beats a paragraph manufactured to fill the space.`,
  },
];

const unit: SeedUnit = {
  name: 'framework-resparkable/003-agents',
  async run({ prisma, logger }) {
    logger.info(`🧠 Seeding ${AGENTS.length} Resparkable agents...`);

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    const profile = await prisma.aiAgentProfile.findUnique({
      where: { slug: RESPARKABLE_PROFILE_SLUG },
      select: { id: true },
    });
    if (!profile) {
      throw new Error(
        `No "${RESPARKABLE_PROFILE_SLUG}" profile — ensure framework-resparkable/002-agent-profile runs first.`
      );
    }

    for (const agent of AGENTS) {
      const guardModes = {
        inputGuardMode: agent.inputGuardMode,
        outputGuardMode: agent.outputGuardMode,
        citationGuardMode: agent.citationGuardMode,
      };

      await prisma.aiAgent.upsert({
        where: { slug: agent.slug },
        update: {
          // Code-adjacent: instructions describe the capabilities this build
          // registered, and the profile link is what carries the guardrails.
          name: agent.name,
          description: agent.description,
          systemInstructions: agent.instructions,
          kind: agent.kind,
          profileId: profile.id,
          personaMode: 'append',
          voiceMode: 'append',
          guardrailsMode: 'append',
          knowledgeAccessMode: 'restricted',
          ...guardModes,
          isSystem: true,
        },
        create: {
          slug: agent.slug,
          name: agent.name,
          description: agent.description,
          systemInstructions: agent.instructions,
          kind: agent.kind,
          // Empty strings → resolved at runtime from the operator's configured
          // default. See the header.
          model: '',
          provider: '',
          temperature: agent.temperature,
          maxTokens: agent.maxTokens,
          ...(agent.maxCostPerTurnUsd === undefined
            ? {}
            : { maxCostPerTurnUsd: agent.maxCostPerTurnUsd }),
          profileId: profile.id,
          personaMode: 'append',
          voiceMode: 'append',
          guardrailsMode: 'append',
          // The global knowledge base is the deployment's documents, not this
          // person's notes. Resparkable documents live in `framework_resparkable_*` and
          // are reached through `resparkable_search`; unrestricted KB access would
          // let an agent answer from a corpus its owner never uploaded.
          knowledgeAccessMode: 'restricted',
          ...guardModes,
          // Internal: these are reached through the app's own authenticated chat
          // route and through MCP keys, never through the public embed.
          visibility: 'internal',
          isActive: true,
          isSystem: true,
          createdBy: admin.id,
        },
      });
      logger.info(`  ✓ ${agent.slug}`);
    }

    logger.info(`✅ Seeded ${AGENTS.length} Resparkable agents`);
  },
};

export default unit;
