import type { Metadata } from 'next';

import { ObsiddyChat } from '@/components/obsiddy/chat/obsiddy-chat';
import { OBSIDDY_AGENT_SLUGS } from '@/lib/framework/obsiddy/agents';

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
 * tasks, capacity — is injected server-side as the `obsiddy` context block on
 * every turn. Fetching a snapshot here to render *around* the chat would show
 * the person a second, staler copy of what the agent is already reading.
 *
 * ## Why the agent slug comes from a constant
 *
 * `OBSIDDY_AGENT_SLUGS.companion`, not a picker. The other four agents hold
 * write capabilities and are meant to be driven by scheduled workflows; the
 * route enforces that against `OBSIDDY_CHAT_AGENT_SLUGS`, and a page that
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

export default function ObsiddyChatPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Chat</h1>
        <p className="text-muted-foreground text-sm">
          It already knows today&rsquo;s date, your goals, what you are working on and how much of
          the week is left. It can search everything you have written, and it can write things down
          — it will say when it has.
        </p>
      </div>

      <ObsiddyChat agentSlug={OBSIDDY_AGENT_SLUGS.companion} starterPrompts={STARTERS} />
    </div>
  );
}
