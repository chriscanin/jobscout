-- jobscout initial schema (CONTRACT §Database schema, §Enums, §Status machine).
-- Enums are stored as text columns with CHECK constraints so adding a value is a
-- one-line migration. Applied identically to a fresh PGlite (pg15) test DB and to
-- real Supabase via `pnpm db:push`.

-- ---------------------------------------------------------------------------
-- companies
-- ---------------------------------------------------------------------------
create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  ats text not null check (ats in (
    'greenhouse','lever','ashby','workday','icims','taleo',
    'successfactors','oracle','adp','brassring','other','unknown'
  )),
  board_token text,
  careers_url text,
  discovered_via text not null check (discovered_via in ('seed','web-search','manual')),
  active boolean not null default true,
  last_crawled_at timestamptz,
  created_at timestamptz default now(),
  unique (ats, board_token)
);

-- ---------------------------------------------------------------------------
-- jobs
-- ---------------------------------------------------------------------------
create table jobs (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in (
    'greenhouse','lever','ashby','caljobs','indeed','ziprecruiter','discovery'
  )),
  external_id text not null,
  company_id uuid references companies(id),
  url text not null,
  apply_url text,
  title text not null,
  company text not null,
  location text,
  is_remote boolean,
  salary_raw text,
  salary_min integer,
  salary_max integer,
  description text,
  posted_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  role_category text check (role_category in (
    'react-native','react','frontend','fullstack','other'
  )),
  match_score integer,
  match_reasons text[],
  ats text not null default 'unknown' check (ats in (
    'greenhouse','lever','ashby','workday','icims','taleo',
    'successfactors','oracle','adp','brassring','other','unknown'
  )),
  difficulty text not null default 'unknown' check (difficulty in (
    'easy','medium','hard','unknown'
  )),
  difficulty_reasons text[],
  status text not null default 'new' check (status in (
    'new','notified','queued','applied','dismissed','expired'
  )),
  notes text,
  dedup_hash text not null,
  missing_streak integer not null default 0,
  notified_at timestamptz,
  applied_at timestamptz,
  dismissed_at timestamptz,
  raw jsonb,
  unique (source, external_id)
);

create index jobs_dedup_hash_idx on jobs (dedup_hash);

-- ---------------------------------------------------------------------------
-- crawl_runs
-- ---------------------------------------------------------------------------
create table crawl_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz,
  finished_at timestamptz,
  trigger text check (trigger in ('launchd','manual','loop')),
  stats jsonb,
  notified_count integer,
  ok boolean
);

-- ---------------------------------------------------------------------------
-- criteria (single row, id = 1) seeded with the contract default JSON verbatim.
-- Keep in sync with DEFAULT_CRITERIA in packages/core/src/schemas.ts.
-- ---------------------------------------------------------------------------
create table criteria (
  id smallint primary key check (id = 1),
  value jsonb not null,
  updated_at timestamptz
);

insert into criteria (id, value, updated_at) values (
  1,
  '{
    "role_priorities": [
      { "category": "react-native", "priority": 1,
        "keywords": ["react native", "mobile developer", "mobile engineer", "expo", "ios engineer", "android engineer"] },
      { "category": "react", "priority": 2,
        "keywords": ["react developer", "react engineer", "react.js"] },
      { "category": "frontend", "priority": 2,
        "keywords": ["frontend", "front-end", "front end", "ui engineer", "web developer"] },
      { "category": "fullstack", "priority": 3,
        "keywords": ["full stack", "fullstack", "full-stack"] }
    ],
    "exclude_keywords": ["angular", "vue", ".net", "wordpress", "drupal", "staff", "principal", "director", "manager"],
    "locations": { "remote_us": true, "states": ["CA"], "cities": [] },
    "min_salary": null,
    "notify_min_score": 60
  }'::jsonb,
  now()
);
