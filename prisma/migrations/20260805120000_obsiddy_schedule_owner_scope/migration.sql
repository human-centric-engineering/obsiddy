-- Stamp the owner onto every Obsiddy schedule's `scope`, before any tick runs.
--
-- Sunrise 0.8.0 (sunrise#502) made schedule-triggered runs system-owned: the
-- scheduler writes `userId: null` on the execution and passes null into the
-- engine, instead of `schedule.createdBy`. Correct for the org-level cron rows
-- core has in mind — `AiWorkflowExecution.userId` is `onDelete: Cascade`, so
-- naming an operator meant erasing them destroyed the organisation's whole
-- scheduled-run history.
--
-- It also removed the only mechanism by which Obsiddy's per-user schedules knew
-- whose brain a background run was working on. The owner now travels in the
-- row's `scope` column instead (`OBSIDDY_SCHEDULE_OWNER_KEY = obsiddyUserId`),
-- which core stamps onto the execution and threads into
-- `CapabilityContext.scope`.
--
-- `ensureObsiddySchedules()` already heals rows written before that move — but
-- it heals them from the connection sweep, and `runMaintenanceTick` **awaits
-- `processDueSchedules()` first**, then runs app jobs (`run-tick.ts`). So on the
-- first tick after an upgrade, any schedule already due fires before the sweep
-- can reach it, and that run has no owner: every capability in it throws, at
-- 03:15 or 04:30, where nothing surfaces it. One failed briefing per install is
-- a small thing to leave lying around when the whole point of the fix was that
-- silently broken schedules are the expensive kind.
--
-- Doing it here closes that window: migrations run at deploy, before the first
-- tick. The runtime correction stays as the backstop for rows created by any
-- path this does not cover.
--
-- Scoped to Obsiddy's own rows. `AiWorkflowSchedule` is core-owned and a host
-- project has its own schedules in it, so the slug prefix is what keeps this
-- from writing an `obsiddyUserId` onto somebody else's schedule. It matches
-- `obsiddyScheduleWhere()` in `repo/schedules.ts`.
--
-- Idempotent: rows already carrying the correct owner are skipped, so a re-run
-- is a no-op. A row whose scope names a DIFFERENT user is overwritten — that is
-- corruption, not a preference, and `createdBy` is the authority.

UPDATE "ai_workflow_schedule" s
SET "scope" = jsonb_build_object('obsiddyUserId', s."createdBy")
FROM "ai_workflow" w
WHERE w."id" = s."workflowId"
  AND w."slug" LIKE 'obsiddy-%'
  -- Rows orphaned by erasure (`createdBy` is SetNull) get nothing: there is no
  -- owner to name. The connection sweep deletes those separately.
  AND s."createdBy" IS NOT NULL
  AND (
    s."scope" IS NULL
    OR s."scope"->>'obsiddyUserId' IS DISTINCT FROM s."createdBy"
  );
