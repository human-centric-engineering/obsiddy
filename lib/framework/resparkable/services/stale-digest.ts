/**
 * The stale digest — "you haven't touched Acme since April — still a client?"
 *
 * §11's position, which this file implements literally: **obsolescence is a
 * question, not a rule.** Retention archives what a clock can judge safely
 * (a completed task from last spring); everything where age is a poor proxy for
 * irrelevance comes here instead and gets asked. Nothing in this file writes,
 * except the explicit answer a person gives.
 *
 * The four windows are separate because the questions are not comparable — a
 * project quiet for six weeks probably is dead, and a life goal untouched for a
 * year certainly is not. They are constants rather than user settings on
 * purpose: these tune *how often you are asked something*, and a retention
 * policy screen with a dozen sliders is a screen nobody finishes reading. The
 * eight windows that destroy or hide data are the ones worth exposing.
 *
 * ## Tone
 *
 * §11 says the digest is the one place the agent should be blunt, and that is a
 * product decision with a reason behind it: a digest that softens every row into
 * "you might perhaps want to consider revisiting…" is a digest that never gets
 * a decision out of anyone, so nothing is ever archived and the list grows until
 * it is ignored. The rows this service produces carry facts and dates; the
 * workflow prompt does the wording.
 */

import type { OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import {
  findAreasWithoutTime,
  findDormantEntities,
  findDormantProjects,
  findGoalsPastTarget,
  markStillLive,
  type StaleRow,
  type StillLiveType,
} from '@/lib/framework/resparkable/repo/stale';
import { daysBefore } from '@/lib/framework/resparkable/repo/retention';
import { recordResparkableEvent } from '@/lib/framework/resparkable/services/events';

/**
 * How long each type may be quiet before the digest asks about it.
 *
 * From §11's list, which chose them by how fast each type actually goes stale in
 * a life rather than by a tidy shared number.
 */
export const STALE_WINDOW_DAYS = {
  /** "No activity and no completed tasks in 90 days." */
  project: 90,
  /** A target date that has passed, with no progress behind it. */
  goal: 90,
  /** "Zero logged time in 60 days" — the shortest, because a week is the unit. */
  area: 60,
  /** "You haven't touched Acme since April" — never auto-archived, only asked. */
  entity: 90,
} as const;

export type StaleSectionName = keyof typeof STALE_WINDOW_DAYS;

export interface StaleSection {
  /** Which question this section asks. */
  type: StaleSectionName;
  /** How quiet a row had to be to appear here. */
  windowDays: number;
  rows: Array<{
    id: string;
    title: string;
    lastSignalAt: string | null;
    /** Whole days since the last signal, or `null` when there has never been one. */
    quietDays: number | null;
  }>;
}

export interface StaleDigest {
  generatedAt: string;
  sections: StaleSection[];
  /** Rows across every section. Zero is a real and common answer. */
  total: number;
}

/**
 * Build the digest for one brain.
 *
 * Four bounded queries plus one for the entity link check — a fixed count, not
 * one per row, for the same reason every other Resparkable surface assembles in a
 * fixed count: this is rendered as a page and read by a workflow, and an N+1
 * here would be invisible until someone had two hundred entities.
 */
export async function buildStaleDigest(
  scope: OwnerScope,
  now: Date = new Date()
): Promise<StaleDigest> {
  const [projects, goals, areas, entities] = await Promise.all([
    findDormantProjects(scope, daysBefore(now, STALE_WINDOW_DAYS.project)),
    findGoalsPastTarget(scope, now, daysBefore(now, STALE_WINDOW_DAYS.goal)),
    findAreasWithoutTime(scope, daysBefore(now, STALE_WINDOW_DAYS.area)),
    findDormantEntities(scope, daysBefore(now, STALE_WINDOW_DAYS.entity)),
  ]);

  const sections: StaleSection[] = [
    section('project', projects, now),
    section('goal', goals, now),
    section('area', areas, now),
    section('entity', entities, now),
  ];

  return {
    generatedAt: now.toISOString(),
    sections,
    total: sections.reduce((sum, item) => sum + item.rows.length, 0),
  };
}

function section(type: StaleSectionName, rows: StaleRow[], now: Date): StaleSection {
  return {
    type,
    windowDays: STALE_WINDOW_DAYS[type],
    rows: rows.map((row) => ({
      id: row.id,
      title: row.title,
      lastSignalAt: row.lastSignalAt?.toISOString() ?? null,
      quietDays: row.lastSignalAt ? daysBetween(row.lastSignalAt, now) : null,
    })),
  };
}

/**
 * Whole days between two instants.
 *
 * Deliberately not timezone-aware, and this is the one date calculation in the
 * tier where that is correct: "quiet for 94 days" is a duration, not a calendar
 * position, so it does not change meaning across a DST boundary the way "9am
 * tomorrow" does. Everything that schedules resolves through `time/zoned.ts`.
 */
function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000)));
}

/**
 * Record the user's answer that something is still live.
 *
 * Writes `lastActivityAt = now` and an event. The event is what makes the answer
 * visible in the activity log rather than only in a column — and, because it
 * goes through `recordResparkableEvent`, it also drops the chat context cache, so an
 * agent asked about the project a minute later does not still describe it as
 * neglected.
 *
 * Returns false when the row is not the caller's, which the route turns into a
 * 404 — not-found and not-yours are the same answer everywhere in this tier.
 */
export async function confirmStillLive(
  scope: OwnerScope,
  type: StillLiveType,
  id: string,
  now: Date = new Date()
): Promise<boolean> {
  const updated = await markStillLive(scope, type, id, now);
  if (!updated) return false;

  await recordResparkableEvent(scope, {
    kind: 'updated',
    entityType: type,
    entityId: id,
    metadata: { stillLive: true },
  });

  return true;
}
