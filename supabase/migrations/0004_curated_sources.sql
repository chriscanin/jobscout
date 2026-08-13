-- Curated discovery sources (spec: curated-sources).
-- Companies can now be discovered via seven curated startup-intel sources in
-- addition to seed / web-search / manual. Enums stay text + CHECK (0001 note).

alter table companies drop constraint companies_discovered_via_check;
alter table companies add constraint companies_discovered_via_check check (
  discovered_via in (
    'seed','web-search','manual',
    'yc-directory',
    'ramp-vendor-report',
    'harmonic-hot25',
    'a16z-build',
    'founders-you-should-know',
    'next-play',
    'early-days'
  )
);

-- ---------------------------------------------------------------------------
-- source_items: one row per processed newsletter issue / report page / batch
-- slice, so re-running the sources command never re-extracts the same item.
-- ---------------------------------------------------------------------------
create table source_items (
  id uuid primary key default gen_random_uuid(),
  source_key text not null check (source_key in (
    'yc-directory',
    'ramp-vendor-report',
    'harmonic-hot25',
    'a16z-build',
    'founders-you-should-know',
    'next-play',
    'early-days'
  )),
  item_url text not null,
  title text,
  companies_found integer not null default 0,
  processed_at timestamptz not null default now(),
  unique (source_key, item_url)
);
