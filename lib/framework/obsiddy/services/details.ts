/**
 * The `/view` builders — one enriched read per detail page.
 *
 * ## Why these exist rather than an `?include=` on the item routes
 *
 * A project page needs the project, its area, its tasks in score order, its
 * connections with both endpoints resolved, and counts. Assembled from the generic
 * `GET /obsiddy/projects/[id]` that is one request plus one per task plus one per
 * link — the N+1 `CLAUDE.md` forbids, and on a busy project that is thirty
 * requests assembling a page in front of the user.
 *
 * The generic item handlers stay deliberately bare. Threading per-resource
 * `include` support through `createItemHandlers` would push page-shaped concerns
 * into the one factory that guarantees the isolation rules for twenty routes, and
 * that factory's value is that it has nothing else in it.
 *
 * ## The query count is fixed, and that is the contract
 *
 * Every builder here issues a bounded number of queries regardless of how many
 * tasks or links come back: the entity, its parent, one batched task read, one
 * batched link read, and one `findSummaries` per distinct endpoint type (at most
 * seven). Nothing loops over rows issuing queries. A regression here would not
 * fail a test that only checks the shape, so the route tests assert the count.
 *
 * ## Deliberately absent: tags and checklists
 *
 * `buildTaskView` will grow them when the boards work lands the repo modules they
 * need. Returning empty arrays now would be a lie the UI builds against; leaving
 * the fields out means adding them later is additive.
 */

import { findArea } from '@/lib/framework/obsiddy/repo/areas';
import { findEntity } from '@/lib/framework/obsiddy/repo/entities';
import { findGoal } from '@/lib/framework/obsiddy/repo/goals';
import { listLinksForEntity } from '@/lib/framework/obsiddy/repo/links';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { findProject } from '@/lib/framework/obsiddy/repo/projects';
import { countTasks, findTask, listTasks } from '@/lib/framework/obsiddy/repo/tasks';
import {
  hydrateLinks,
  otherEnd,
  type LinkEndpoint,
} from '@/lib/framework/obsiddy/services/link-hydration';
import type { ObsiddyArea, ObsiddyEntity, ObsiddyProject, ObsiddyTask } from '@prisma/client';

/** Links shown on a detail page. Beyond this it is a graph, not a page. */
const LINK_LIMIT = 40;

/** Tasks listed on a project page, in score order. */
const TASK_LIMIT = 100;

/** Statuses that are finished business — mirrors `services/today.ts`. */
const CLOSED_TASK_STATUSES = ['done', 'dropped'];

/**
 * A connection as a detail page wants it: the *other* end, plus which way it
 * points.
 *
 * Pages ask "what is this connected to", and resolving direction here means no
 * client has to check which end it was on — the check that gets forgotten and
 * silently halves the list.
 */
export interface RelatedItem {
  linkId: string;
  kind: string;
  status: string;
  origin: string;
  strength: number | null;
  rationale: string | null;
  direction: 'outgoing' | 'incoming';
  endpoint: LinkEndpoint;
}

export interface ProjectViewPayload {
  project: ObsiddyProject;
  area: ObsiddyArea | null;
  tasks: ObsiddyTask[];
  /** Open tasks, and how many of them there are in total beyond the page. */
  openTaskCount: number;
  totalTaskCount: number;
  related: RelatedItem[];
}

export async function buildProjectView(
  scope: OwnerScope,
  id: string
): Promise<ProjectViewPayload | null> {
  const project = await findProject(scope, id);
  // Missing and not-yours are indistinguishable by construction (§16.2).
  if (!project) return null;

  const [area, tasks, openTaskCount, totalTaskCount, links] = await Promise.all([
    project.areaId ? findArea(scope, project.areaId) : Promise.resolve(null),
    // Score order comes from the indexed column, not from a sort here (D3).
    listTasks(scope, { projectId: id }, { take: TASK_LIMIT }),
    countTasks(scope, { projectId: id, excludeStatuses: CLOSED_TASK_STATUSES }),
    countTasks(scope, { projectId: id }),
    listLinksForEntity(scope, 'project', id, {
      // Rejected links are tombstones the sweep reads; they are not connections a
      // person should see listed (§17 risk 5c).
      statuses: ['accepted', 'suggested', 'proposed'],
      take: LINK_LIMIT,
    }),
  ]);

  return {
    project,
    area,
    tasks,
    openTaskCount,
    totalTaskCount,
    related: await toRelated(scope, links, 'project', id),
  };
}

export interface EntityViewPayload {
  entity: ObsiddyEntity;
  /**
   * Everything linked to this person or company.
   *
   * This is the entity page's whole reason to exist: an entity is a lens, not a
   * container. It owns nothing — the plan is explicit that entities are absent
   * from `score.ts` so a neglected client cannot inflate task scores — so the only
   * thing to show is what it is connected to.
   */
  related: RelatedItem[];
}

export async function buildEntityView(
  scope: OwnerScope,
  id: string
): Promise<EntityViewPayload | null> {
  const entity = await findEntity(scope, id);
  if (!entity) return null;

  const links = await listLinksForEntity(scope, 'entity', id, {
    statuses: ['accepted', 'suggested', 'proposed'],
    take: LINK_LIMIT,
  });

  return { entity, related: await toRelated(scope, links, 'entity', id) };
}

export interface TaskViewPayload {
  task: ObsiddyTask;
  project: ObsiddyProject | null;
  area: ObsiddyArea | null;
  /** The task's own goal, walked project → goal where there is one. */
  goalTitle: string | null;
  related: RelatedItem[];
}

export async function buildTaskView(
  scope: OwnerScope,
  id: string
): Promise<TaskViewPayload | null> {
  const task = await findTask(scope, id);
  if (!task) return null;

  const project = task.projectId ? await findProject(scope, task.projectId) : null;

  const [area, links] = await Promise.all([
    project?.areaId ? findArea(scope, project.areaId) : Promise.resolve(null),
    listLinksForEntity(scope, 'task', id, {
      statuses: ['accepted', 'suggested', 'proposed'],
      take: LINK_LIMIT,
    }),
  ]);

  return {
    task,
    project,
    area,
    goalTitle: await resolveGoalTitle(scope, project),
    related: await toRelated(scope, links, 'task', id),
  };
}

/**
 * The goal a task ultimately serves, for the "why am I doing this" line.
 *
 * Only the direct `project → goal` link, and only an accepted one. The scorer
 * walks further than this (through `ObsiddyLink` chains) but a detail page showing
 * a four-hop inference as "this serves X" would be asserting more than it knows.
 */
async function resolveGoalTitle(
  scope: OwnerScope,
  project: ObsiddyProject | null
): Promise<string | null> {
  if (!project) return null;

  const links = await listLinksForEntity(scope, 'project', project.id, {
    statuses: ['accepted'],
    take: 10,
  });

  const goalLink = links.find(
    (link) =>
      (link.sourceType === 'goal' && link.targetId === project.id) ||
      (link.targetType === 'goal' && link.sourceId === project.id)
  );
  if (!goalLink) return null;

  const goalId = goalLink.sourceType === 'goal' ? goalLink.sourceId : goalLink.targetId;
  const goal = await findGoal(scope, goalId);
  return goal?.title ?? null;
}

/** Hydrate a batch of links and reduce each to the end the page cares about. */
async function toRelated(
  scope: OwnerScope,
  links: Awaited<ReturnType<typeof listLinksForEntity>>,
  selfType: string,
  selfId: string
): Promise<RelatedItem[]> {
  const hydrated = await hydrateLinks(scope, links);

  return hydrated.map((entry) => {
    const { endpoint, direction } = otherEnd(entry, selfType, selfId);
    return {
      linkId: entry.link.id,
      kind: entry.link.kind,
      status: entry.link.status,
      origin: entry.link.origin,
      strength: entry.link.strength,
      rationale: entry.link.rationale,
      direction,
      endpoint,
    };
  });
}
