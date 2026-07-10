-- Add the first-class remote-US-only signal (CONTRACT §Location filter).
--
-- `remote_us_ok` is judged by the LLM during scoring (and can be forced false by
-- a deterministic relocation-question override). It gates Discord notification:
-- only jobs with remote_us_ok = true are notified. NULL means "not yet judged"
-- (a freshly upserted, unscored job), so it is nullable with no default.
--
-- Applied identically to a fresh PGlite (pg15) test DB and to real Supabase via
-- `pnpm db:push`. Must apply cleanly on top of 0001_init.sql.

alter table jobs add column remote_us_ok boolean;

-- Keep the seeded criteria row (id = 1) in sync with DEFAULT_CRITERIA, which now
-- carries an explicit `location_requirement` string the scorer reads verbatim
-- when judging `remote_us_ok`. Only add it when absent so a user-edited value is
-- not clobbered.
update criteria
set value = jsonb_set(
      value,
      '{location_requirement}',
      '"Remote-only AND based in / open to the United States. EXCLUDE hybrid, on-site, non-US locations, and any posting that requires or asks about relocation."'::jsonb,
      true
    ),
    updated_at = now()
where id = 1
  and not (value ->> 'location_requirement' is not null);
