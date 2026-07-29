/**
 * `GET /obsiddy/inbox` — captured thoughts, each with what the system thinks it
 * connects to.
 *
 * The inbox is the front door of the product: things arrive here half-formed
 * from a phone, an email, a voice note, and triage is the act of deciding what
 * each one is. Showing the suggested connections *inline* is what makes that a
 * decision rather than an archaeology exercise — "this looks like it belongs to
 * the Q4 launch project" is the single most useful thing to put next to a
 * two-line note you wrote nine days ago.
 *
 * Suggestions are read from `ObsiddyLink`, which the connection sweep populates
 * in phase 4. Until then every thought comes back with an empty list, and that
 * is the correct behaviour rather than a stub: the shape is real, so the UI
 * built against it does not change when the sweep starts writing.
 */

import { listSuggestedLinksForSources } from '@/lib/framework/obsiddy/repo/links';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { findProjectsByIds } from '@/lib/framework/obsiddy/repo/projects';
import { countThoughts, listThoughts } from '@/lib/framework/obsiddy/repo/thoughts';
import type { ObsiddyThought } from '@prisma/client';

export interface InboxSuggestedLink {
  id: string;
  targetType: string;
  targetId: string;
  kind: string;
  strength: number | null;
  rationale: string | null;
  /** Resolved for project targets so the UI can show a name, not a cuid. */
  targetLabel: string | null;
}

export interface InboxThought {
  thought: ObsiddyThought;
  suggestedLinks: InboxSuggestedLink[];
  /**
   * The strongest suggested project, pulled out because "file this under…" is
   * the one action triage takes most, and making the UI hunt for it in the
   * links array would mean every client re-deriving the same rule.
   */
  suggestedProjectId: string | null;
}

export interface InboxPayload {
  generatedAt: string;
  items: InboxThought[];
  total: number;
}

export interface InboxOptions {
  limit?: number;
  offset?: number;
}

export async function buildInbox(
  scope: OwnerScope,
  options: InboxOptions = {},
  now = new Date()
): Promise<InboxPayload> {
  // Snoozed thoughts are out: the inbox is what needs deciding *now*, and a
  // thought you pushed to next Monday is not that (§10).
  const filters = { status: 'inbox', hideSnoozed: true };

  const [thoughts, total] = await Promise.all([
    listThoughts(scope, filters, { take: options.limit, skip: options.offset }),
    countThoughts(scope, filters),
  ]);

  if (thoughts.length === 0) {
    return { generatedAt: now.toISOString(), items: [], total };
  }

  // One query for the whole page's links, then one for the projects they point
  // at — never one per thought (CLAUDE.md: no N+1).
  const links = await listSuggestedLinksForSources(
    scope,
    'thought',
    thoughts.map((thought) => thought.id),
    now
  );

  const projectIds = [
    ...new Set(links.filter((link) => link.targetType === 'project').map((link) => link.targetId)),
  ];
  const projects = await findProjectsByIds(scope, projectIds);
  const projectNamesById = new Map(projects.map((project) => [project.id, project.name]));

  const linksByThoughtId = new Map<string, InboxSuggestedLink[]>();
  for (const link of links) {
    const bucket = linksByThoughtId.get(link.sourceId) ?? [];
    bucket.push({
      id: link.id,
      targetType: link.targetType,
      targetId: link.targetId,
      kind: link.kind,
      strength: link.strength,
      rationale: link.rationale,
      // A link whose target has been deleted resolves to null rather than
      // vanishing: `ObsiddyLink` has no FK to its endpoints (D2), so dangling
      // edges are a normal state, not a corruption to hide.
      targetLabel:
        link.targetType === 'project' ? (projectNamesById.get(link.targetId) ?? null) : null,
    });
    linksByThoughtId.set(link.sourceId, bucket);
  }

  return {
    generatedAt: now.toISOString(),
    total,
    items: thoughts.map((thought) => {
      // Already ordered strength-first by the repo, so the first project hit is
      // the strongest one.
      const suggestedLinks = linksByThoughtId.get(thought.id) ?? [];
      const suggestedProject = suggestedLinks.find((link) => link.targetType === 'project');

      return {
        thought,
        suggestedLinks,
        suggestedProjectId: suggestedProject?.targetId ?? null,
      };
    }),
  };
}
