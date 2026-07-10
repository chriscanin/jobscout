-- Lower the seeded notify_min_score from 60 to 50 (CONTRACT §Matching criteria).
--
-- The remote-US feed was too sparse, so the notify threshold drops to 50. This
-- keeps the seeded criteria row (id = 1) in sync with DEFAULT_CRITERIA in
-- packages/core/src/schemas.ts, so a fresh PGlite (0001 -> 0002 -> 0003) seeds
-- notify_min_score = 50 and packages/core/test/data.test.ts stays deep-equal.
--
-- Applied identically to a fresh PGlite (pg15) test DB and to real Supabase via
-- `pnpm db:push`. Must apply cleanly on top of 0002_remote_us_ok.sql.

update criteria
set value = jsonb_set(value, '{notify_min_score}', '50'::jsonb, false),
    updated_at = now()
where id = 1;
