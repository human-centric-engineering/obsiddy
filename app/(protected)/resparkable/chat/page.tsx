import type { Metadata } from 'next';

import { ResparkableChat } from '@/components/resparkable/chat/resparkable-chat';
import { RESPARKABLE_AGENT_SLUGS } from '@/lib/framework/resparkable/agents';

export const metadata: Metadata = {
  title: 'Chat',
  description: 'Talk to the agent that has read everything you have written down.',
};

/**
 * The chat surface.
 *
 * ## The one surface with no server read
 *
 * Every other page in the tier fetches its payload server-side and hands it to a
 * client child (`ui.md` rule 2). This one has nothing to fetch: the transcript
 * lives in the stream, and the orientation an agent needs — goals, projects, top
 * tasks, capacity — is injected server-side as the `resparkable` context block on
 * every turn. Fetching a snapshot here to render *around* the chat would show
 * the person a second, staler copy of what the agent is already reading.
 *
 * ## Why the agent slug comes from a constant
 *
 * `RESPARKABLE_AGENT_SLUGS.companion`, not a picker. The other four agents hold
 * write capabilities and are meant to be driven by scheduled workflows; the
 * route enforces that against `RESPARKABLE_CHAT_AGENT_SLUGS`, and a page that
 * offered them would be offering something the API refuses.
 *
 * ## Starters
 *
 * Four, fixed, and each one demonstrates a different capability — recall,
 * ranking, connections, capture. A person's first question to a second brain is
 * usually "what can you actually do", and answering that by example beats a
 * paragraph of help text.
 */
const STARTERS = [
  'What did I decide about this?',
  'What should I work on today?',
  'What have I written that connects?',
  'Remember this for me…',
] as const;

export default function ResparkableChatPage() {
  return (
    <div className="space-y-4">
      {/* No heading here: the shell's `<SectionHeader>` names the section and its
          ⓘ carries what this page used to say in prose — that the agent already
          knows the date, the goals and the week, and that it says when it writes. */}
      <ResparkableChat agentSlug={RESPARKABLE_AGENT_SLUGS.companion} starterPrompts={STARTERS} />
    </div>
  );
}
