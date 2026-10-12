-- Per-person tracking (2026-10): the board is shared with friends, and each
-- person keeps their own queue. The crawler-owned lifecycle on jobs.status
-- (new / notified / expired) stays global; queued / applied / dismissed and
-- notes move here, one row per person per posting.
--
-- A person signs in by opening an invite link. Only the SHA-256 of the link's
-- token is stored, so a database read never reveals a usable link.
--
-- Applied identically to a fresh PGlite (pg15) test DB and to the real
-- database. Must apply cleanly on top of 0005_more_sources.sql.

create table people (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  token_hash text not null unique,
  is_owner boolean not null default false,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

create table person_jobs (
  person_id uuid not null references people(id) on delete cascade,
  job_id uuid not null references jobs(id) on delete cascade,
  -- null = no decision yet (the row exists only to hold notes)
  status text check (status in ('queued','applied','dismissed')),
  notes text,
  queued_at timestamptz,
  applied_at timestamptz,
  dismissed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (person_id, job_id)
);

create index person_jobs_job_idx on person_jobs (job_id);
