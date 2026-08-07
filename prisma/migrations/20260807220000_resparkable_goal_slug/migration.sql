-- Give a goal an address of its own, so two importers can stop guessing at it.
--
-- ⚠️ HAND-EDITED. Do not regenerate. ⚠️
--
-- `prisma migrate diff` emits the usual destructive statements around the real
-- change (the B1 cascade FK, baseline indexes A2–A4, Resparkable's B3/B5/B7, and
-- the `ALTER COLUMN "searchVector" DROP DEFAULT` on GENERATED columns). All
-- removed — see 20260729212556's header for the full list and the reasoning.
--
-- WHY THIS EXISTS
--
-- Areas, projects and entities have had `@@unique([userId, slug])` since the
-- table was created. Goals never did, and the gap was not cosmetic: a slug is
-- what makes a row recognisable across two systems, and without one every
-- surface that has to answer "have I seen this goal before?" was forced to
-- guess from the title.
--
-- Two of them were getting it wrong in the same way. `vault/import-plan.ts`
-- excludes goals from `SLUG_IDENTITY_TYPES`, so a hand-written `Goals/…md` note
-- created a *second* goal on every import, for ever. The account importer had to
-- fall back to a soft key — horizon, normalised title, target date — which is a
-- considered guess and was the one thing blocking `conflictMode: 'overwrite'`,
-- because writing into a row matched by a key with no constraint behind it is
-- writing into a guess.
--
-- The vault has always filed a goal at `Goals/<horizon>/<slug>.md`, computing
-- that slug from the title on the way out and throwing it away. So the address
-- already existed and was simply not stored. This stores it.
--
-- THE BACKFILL
--
-- Same rule as `services/slug.ts`: lowercase, runs of non-alphanumerics to a
-- single hyphen, no leading or trailing hyphen, 60 characters, and `item` for a
-- title that survives none of that (an emoji-only goal, a title in a script this
-- rule strips entirely). Kept in step deliberately — a backfill that produced
-- different slugs from the ones the application mints would give every existing
-- goal an address that changes the next time somebody edits it.
--
-- De-duplication mirrors `resolveUniqueSlug` too: oldest goal keeps the bare
-- slug, later ones take `-2`, `-3`. Re-run until clean, because a rename can
-- collide with a slug that was already there ("Health" twice plus a literal
-- "Health 2"), and then bounded by a suffix from the row's own id — which is
-- unique by construction, so the loop cannot fail to terminate. The unique
-- index at the end is the last line of defence rather than the only one.

ALTER TABLE "framework_resparkable_goal" ADD COLUMN "slug" TEXT;

UPDATE "framework_resparkable_goal"
SET "slug" = COALESCE(
  NULLIF(
    SUBSTRING(
      TRIM(BOTH '-' FROM regexp_replace(lower("title"), '[^a-z0-9]+', '-', 'g'))
      FROM 1 FOR 60
    ),
    ''
  ),
  'item'
);

DO $$
DECLARE
  renamed INTEGER;
  passes INTEGER := 0;
BEGIN
  LOOP
    WITH ranked AS (
      SELECT
        "id",
        "slug",
        row_number() OVER (
          PARTITION BY "userId", "slug" ORDER BY "createdAt", "id"
        ) AS position
      FROM "framework_resparkable_goal"
    )
    UPDATE "framework_resparkable_goal" AS goal
    SET "slug" = SUBSTRING(ranked."slug" || '-' || ranked.position FROM 1 FOR 60)
    FROM ranked
    WHERE goal."id" = ranked."id" AND ranked.position > 1;

    GET DIAGNOSTICS renamed = ROW_COUNT;
    EXIT WHEN renamed = 0;

    passes := passes + 1;
    -- Five passes is far more than a real account needs, and a cap is what makes
    -- "cannot fail to terminate" true rather than merely likely. Anything still
    -- contested falls back to its own id: uglier, and correct.
    IF passes >= 5 THEN
      WITH ranked AS (
        SELECT
          "id",
          "slug",
          row_number() OVER (
            PARTITION BY "userId", "slug" ORDER BY "createdAt", "id"
          ) AS position
        FROM "framework_resparkable_goal"
      )
      UPDATE "framework_resparkable_goal" AS goal
      SET "slug" = SUBSTRING(ranked."slug" FROM 1 FOR 51) || '-' || SUBSTRING(goal."id" FROM 1 FOR 8)
      FROM ranked
      WHERE goal."id" = ranked."id" AND ranked.position > 1;

      EXIT;
    END IF;
  END LOOP;
END $$;

ALTER TABLE "framework_resparkable_goal" ALTER COLUMN "slug" SET NOT NULL;

CREATE UNIQUE INDEX "framework_resparkable_goal_userId_slug_key"
  ON "framework_resparkable_goal"("userId", "slug");
