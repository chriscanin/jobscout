-- Wider net (2026-08-02): job-level sources (HN Who is hiring, RemoteOK,
-- Remotive, We Work Remotely), three new ATS board APIs (SmartRecruiters,
-- Workable, Recruitee), more curated discovery sources (VC portfolios, funding
-- news, Product Hunt, Pragmatic Engineer, annual startup lists), and a
-- mobile-first broadening of the react-native keyword group.
--
-- Applied identically to a fresh PGlite (pg15) test DB and to real Postgres.
-- Must apply cleanly on top of 0004_curated_sources.sql.

-- jobs.source
alter table jobs drop constraint jobs_source_check;
alter table jobs add constraint jobs_source_check check (
  source in (
    'greenhouse','lever','ashby',
    'smartrecruiters','workable','recruitee',
    'caljobs','indeed','ziprecruiter',
    'hn','remoteok','remotive','weworkremotely',
    'discovery'
  )
);

-- jobs.ats
alter table jobs drop constraint jobs_ats_check;
alter table jobs add constraint jobs_ats_check check (
  ats in (
    'greenhouse','lever','ashby',
    'smartrecruiters','workable','recruitee',
    'workday','icims','taleo','successfactors','oracle','adp','brassring',
    'other','unknown'
  )
);

-- companies.ats
alter table companies drop constraint companies_ats_check;
alter table companies add constraint companies_ats_check check (
  ats in (
    'greenhouse','lever','ashby',
    'smartrecruiters','workable','recruitee',
    'workday','icims','taleo','successfactors','oracle','adp','brassring',
    'other','unknown'
  )
);

-- companies.discovered_via
alter table companies drop constraint companies_discovered_via_check;
alter table companies add constraint companies_discovered_via_check check (
  discovered_via in (
    'seed','web-search','manual',
    'yc-directory','ramp-vendor-report','harmonic-hot25','a16z-build',
    'founders-you-should-know','next-play','early-days',
    'vc-a16z','vc-sequoia','vc-index','vc-founders-fund',
    'tc-funding','product-hunt','pragmatic-engineer','startup-lists'
  )
);

-- source_items.source_key
alter table source_items drop constraint source_items_source_key_check;
alter table source_items add constraint source_items_source_key_check check (
  source_key in (
    'yc-directory','ramp-vendor-report','harmonic-hot25','a16z-build',
    'founders-you-should-know','next-play','early-days',
    'vc-a16z','vc-sequoia','vc-index','vc-founders-fund',
    'tc-funding','product-hunt','pragmatic-engineer','startup-lists'
  )
);

-- Broaden the react-native priority group to mobile-wide keywords, keeping the
-- seeded criteria row (id = 1) deep-equal to DEFAULT_CRITERIA in
-- packages/core/src/schemas.ts. Positional-independent: rewrites only the
-- group whose category is react-native, wherever it sits in the array.
update criteria
set value = jsonb_set(
      value,
      '{role_priorities}',
      (
        select jsonb_agg(
          case
            when elem ->> 'category' = 'react-native'
              then jsonb_set(
                elem,
                '{keywords}',
                '["react native","react-native","expo","mobile","ios","android","swift","kotlin","flutter"]'::jsonb
              )
            else elem
          end
        )
        from jsonb_array_elements(value -> 'role_priorities') elem
      ),
      false
    ),
    updated_at = now()
where id = 1;
