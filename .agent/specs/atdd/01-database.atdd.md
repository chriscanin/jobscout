# ATDD Specification: Database schema and data layer

## 1. Problem Statement

**Context.** jobscout runs its crawler on a disposable Mac; per the contract, all state lives in
Supabase Postgres. Every other component — adapters, classifier, notifier, admin — reads and writes
jobs exclusively through the typed data layer in `packages/core`.

**The Gap.** Neither the schema (`supabase/migrations`) nor the data layer exists. There is no
enforced upsert rule, no status machine, no dedup hash, and no criteria storage.

**Impact.** Without this seam, re-crawls would duplicate jobs, overwrite the user's queue decisions
(`queued`/`applied`), notify the same posting twice under a slightly different company spelling, or
expire jobs the user is actively working. Every later spec depends on the behavior pinned here.

## 2. System Constraints & Environment

- TypeScript, Node 22, pnpm workspaces. Data layer in `packages/core`; SQL migrations in
  `supabase/migrations`. Tests are vitest; commands are `pnpm test`, `pnpm typecheck`, `pnpm build`.
- Supabase Postgres. Both apps use the service-role key server-side only. Tests run against a local
  Supabase instance (`supabase start`), with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` pointing
  at it. `supabase db reset` applies all migrations before the test run.
- Four tables exactly as CONTRACT.md defines: `jobs`, `companies`, `crawl_runs`, `criteria`. Enums
  are `text` columns with CHECK constraints (`source`, `ats`, `role_category`, `difficulty`,
  `status` on `jobs`; `ats`, `discovered_via` on `companies`; `trigger` on `crawl_runs`).
- Required indexes: unique on `jobs (source, external_id)`, unique on
  `companies (ats, board_token)`, non-unique on `jobs (dedup_hash)`.
- A migration seeds `criteria` with the single row `id = 1` and `value` equal to the contract's
  default matching-criteria JSON verbatim.
- Seed companies file: `supabase/seed/companies.json` (path pinned by this spec; the contract names
  the mechanism but not the path). Entries: `{ name, ats, boardToken?, careersUrl? }`.

`packages/core` exports (signatures are the contract; implementations are not specced here):

```ts
dedupHash(company: string, title: string, location: string | null): string;
// per-field: lowercase -> strip punctuation -> collapse whitespace to single spaces -> trim;
// null location -> "" ; then sha256 hex of `${company}|${title}|${location}`.
// Normalization is per-field so the '|' separators survive punctuation stripping.

upsertJob(job: NormalizedJob): Promise<{ id: string; inserted: boolean }>;
// on insert, `ats` is set from the normalized job's atsHint ('unknown' when absent).
// conflict on (source, external_id): updates last_seen_at (now), mutable fields (url, apply_url,
// title, company, company_id, location, is_remote, salary_*, description [truncated at 20000
// chars], posted_at, raw, dedup_hash, ats [same atsHint rule]) and resets missing_streak to 0.
// Never writes: status, notes, first_seen_at, notified_at, applied_at, dismissed_at,
// match_score, match_reasons, role_category, difficulty, difficulty_reasons.

applyStatusTransition(jobId: string, to: Status): Promise<void>;
// Allowed (from -> to) pairs, exactly: new->notified, new->queued, new->dismissed,
// notified->queued, notified->dismissed, queued->applied, queued->dismissed, applied->queued,
// dismissed->queued, new->expired, notified->expired. Anything else (including self-transitions)
// throws InvalidTransitionError; the row is not modified. Entering notified/applied/dismissed
// stamps notified_at/applied_at/dismissed_at (set on entry, never cleared).

markNotified(jobId: string): Promise<void>;            // = applyStatusTransition(jobId, 'notified')
incrementMissingStreakForMissing(source: Source, seenExternalIds: string[]): Promise<number>;
// +1 missing_streak for jobs of `source` whose external_id is NOT in the list and whose status is
// not 'expired'. Returns affected row count.
expireStaleJobs(): Promise<number>;
// status='expired' where missing_streak >= 2 AND status IN ('new','notified'). Returns count.

getCriteria(): Promise<Criteria>;
updateCriteria(value: unknown): Promise<Criteria>;      // zod CriteriaSchema; throws before writing
recordCrawlRun(run: { startedAt: string; finishedAt: string; trigger: 'launchd'|'manual'|'loop';
  stats: Record<string, { fetched: number; new: number; updated: number; errors: string[] }>;
  notifiedCount: number; ok: boolean }): Promise<string>;   // returns crawl_runs.id
syncSeedCompanies(seed: SeedCompany[]): Promise<{ inserted: number; updated: number }>;
// upsert on (ats, board_token), discovered_via='seed'; on conflict updates name and careers_url
// only — never touches `active` (the user may have deactivated a company in admin).
```

## 3. Black-Box Test Cases

External-payload fixture used below: `apps/crawler/test/fixtures/greenhouse/job-5238290008-questions.json`
— the real response of `GET https://boards-api.greenhouse.io/v1/boards/mattermost/jobs/5238290008?questions=true`.
**Capturing this real payload is implementation task #1.** Do not hand-write it.

### Scenario 1 — Fresh migrations apply cleanly on an empty database (happy path)
- **Given** a local Supabase instance with no jobscout objects
- **When** `supabase db reset` runs
- **Then** it exits 0, and SQL assertions confirm: tables `jobs`, `companies`, `crawl_runs`,
  `criteria` exist; a unique index covers `jobs (source, external_id)`; a unique index covers
  `companies (ats, board_token)`; an index covers `jobs (dedup_hash)`
- **And** `select value from criteria where id = 1` returns JSON deep-equal to the contract default
  (role_priorities with the 4 categories, exclude_keywords, locations, min_salary null,
  notify_min_score 60)
- **And** `insert into jobs (..., status) values (..., 'bogus')` fails with Postgres error `23514`
  (CHECK violation); the same holds for an invalid `source` value and an invalid `crawl_runs.trigger`

### Scenario 2 — Upsert of a brand-new job (happy path)
- **Given** an empty `jobs` table and a `NormalizedJob` built from the Greenhouse fixture above
  (source `greenhouse`, external_id `5238290008`, company `Mattermost, Inc.`, atsHint `greenhouse`)
- **When** `upsertJob(job)` is called
- **Then** it returns `inserted: true`, and the row has `status = 'new'`, `missing_streak = 0`,
  `difficulty = 'unknown'`, `ats = 'greenhouse'`, `first_seen_at = last_seen_at` (exact equality),
  and `dedup_hash = dedupHash(job.company, job.title, job.location ?? null)`

### Scenario 3 — Re-upsert of a seen job never regresses user state
- **Given** the Scenario 2 row, then moved to `queued` via transitions, given `notes = 'call back'`,
  and given `missing_streak = 1` (via `incrementMissingStreakForMissing('greenhouse', [])`)
- **When** `upsertJob` runs again for the same `(source, external_id)` with a changed `title`
- **Then** it returns `inserted: false`; `last_seen_at` is strictly greater than before;
  `missing_streak = 0`; `title` is updated; and `status` is still `'queued'`, `notes` still
  `'call back'`, `first_seen_at` unchanged — and the `jobs` row count is still 1

### Scenario 4 — Status machine: invalid transitions throw (error case)
- **Given** one job per status (`new`, `notified`, `queued`, `applied`, `dismissed`, `expired`)
- **When** `applyStatusTransition` is attempted for **all 36** `(from, to)` pairs
- **Then** exactly the 11 pairs listed in §2 succeed; every other pair (including
  `applied -> notified` and every self-transition) throws `InvalidTransitionError` and leaves the
  row's `status` unchanged
- **And** `markNotified` on a `new` job sets `status = 'notified'` and a non-null `notified_at`;
  calling `markNotified` again on that job throws and does not change `notified_at`

### Scenario 5 — Expiry only hits new/notified with missing_streak >= 2
- **Given** six jobs: (`new`, streak 2), (`notified`, streak 3), (`new`, streak 1),
  (`queued`, streak 5), (`applied`, streak 4), (`dismissed`, streak 2)
- **When** `expireStaleJobs()` runs
- **Then** it returns `2`; only the first two rows now have `status = 'expired'`; the other four
  rows keep their exact prior status and `missing_streak`
- **And** a further `incrementMissingStreakForMissing` call that omits the expired jobs' external
  ids does not change the expired rows' `missing_streak` (expired rows are skipped)

### Scenario 6 — dedup_hash normalization (edge case)
- **Given** the pairs below
- **When** `dedupHash` is computed for each
- **Then** all assertions hold:
  - `dedupHash('Mattermost, Inc.', 'Senior  Software Engineer!', null)`
    `=== dedupHash('mattermost inc', 'senior software engineer', '')`
  - `dedupHash('A', 'B', null) === dedupHash('A', 'B', '')` (null location = empty string)
  - `dedupHash('Acme', 'Engineer', 'Remote') !== dedupHash('Acme', 'Engineer', null)`
  - every returned value matches `/^[0-9a-f]{64}$/` (sha256 hex)

### Scenario 7 — Criteria roundtrip; malformed value rejected by zod, nothing written
- **Given** a freshly reset database, so `getCriteria()` deep-equals the contract default
- **When** `updateCriteria({ ...default, notify_min_score: 'sixty' })` is called
- **Then** it throws a zod validation error, and a subsequent `getCriteria()` still deep-equals the
  default (`criteria.updated_at` unchanged — nothing was written)
- **And when** `updateCriteria({ ...default, notify_min_score: 40 })` is called
- **Then** `getCriteria()` returns `notify_min_score = 40` and `updated_at` advanced

### Scenario 8 — syncSeedCompanies is idempotent and preserves `active`; crawl runs are recorded
- **Given** an empty `companies` table and a seed array of two Greenhouse companies
- **When** `syncSeedCompanies(seed)` runs
- **Then** it returns `{ inserted: 2, updated: 0 }` and both rows have `discovered_via = 'seed'`,
  `active = true`
- **And when** one row is set `active = false` and `syncSeedCompanies` re-runs with the same seed
  but a changed `careersUrl` for that company
- **Then** it returns `{ inserted: 0, updated: 2 }`, the row count is still 2, the changed
  `careers_url` is persisted, and `active` is still `false` for the deactivated row
- **And when** `recordCrawlRun` is called with trigger `'manual'`, per-source stats,
  `notifiedCount: 0`, `ok: true`
- **Then** a `crawl_runs` row exists with those exact values and `stats` roundtrips as JSON

## 4. Definition of Done

- [ ] `supabase db reset` exits 0 against a fresh local instance (all migrations apply to an empty
      database, in order, with no manual steps)
- [ ] `psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -tAc "select count(*) from criteria where id = 1"`
      prints `1`
- [ ] `jq -e '.id == 5238290008' apps/crawler/test/fixtures/greenhouse/job-5238290008-questions.json`
      exits 0 (fixture captured from the real Greenhouse API, not hand-written)
- [ ] `pnpm test` exits 0, with Scenarios 1–8 implemented as vitest tests under `packages/core`
      (no skipped or stubbed tests)
- [ ] `pnpm typecheck` exits 0
