# ATDD Specification: Admin app (Next.js + Auth0 + Supabase)

Conforms to `/Users/chris/Workspace/jobscout/.agent/specs/atdd/CONTRACT.md`. If this file and the contract disagree, the contract wins.

## 1. Problem Statement

**Context.** The crawler fills Supabase with jobs and posts matches to Discord. Chris then needs one place to work the queue: see what came in, queue or dismiss jobs, mark ones he applied to, tune the matching criteria, and check whether last night's crawl actually ran. Discord alone can't do any of that.

**The Gap.** Without an admin app there is no way to change a job's `status`, edit `criteria.value`, or see `crawl_runs` without opening the Supabase dashboard or ssh-ing into the crawler Mac and writing SQL by hand. There is also no safe web surface: the database is private (service-role key only), so any web UI must keep that key strictly server-side.

**Impact.** `apps/admin` is a small Next.js (App Router) app on Vercel, gated by Auth0 with an email allowlist (one user in practice). Four pages, one nav bar, tables — no dashboards. All reads/writes go through the `packages/core` data layer server-side with `SUPABASE_SERVICE_ROLE_KEY`. The service key must never reach the client: no `NEXT_PUBLIC_` Supabase variables anywhere, and a build-time check proves the key string is absent from the client bundle.

## 2. System Constraints & Environment

- **Runtime:** TypeScript, Node 22, pnpm workspace `apps/admin`. Next.js App Router. Deployed to Vercel. Tests: vitest (`pnpm test`), plus `pnpm typecheck` and `pnpm build`.
- **Auth:** `@auth0/nextjs-auth0`. Every route sits behind the Auth0 middleware. After login, the session email must appear in `ADMIN_ALLOWED_EMAILS` (comma-separated, compared case-insensitively after trimming) or the user gets a 403 page. There is no self-serve signup path in the app.
- **Env (Vercel, server-side only):** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `AUTH0_SECRET`, `AUTH0_BASE_URL`, `AUTH0_ISSUER_BASE_URL`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `ADMIN_ALLOWED_EMAILS`. **Forbidden:** any env var matching `NEXT_PUBLIC_SUPABASE*`. The Supabase client is constructed only in server code (server components, server actions, route handlers).
- **Data access:** exclusively through `packages/core` (tables `jobs`, `companies`, `crawl_runs`, `criteria`; enums and status machine per contract). No direct Supabase client in client components.
- **Status changes** go through the `packages/core` transition guard. Contract statement of the seam:

```ts
// packages/core — these are the exact exports pinned in 01-database.atdd.md §2, referenced
// verbatim; InvalidTransitionError and the transition rules are the same objects 01 defines.
class InvalidTransitionError extends Error { from: Status; to: Status }   // defined in 01
function applyStatusTransition(jobId: string, to: Status): Promise<void>; // defined in 01: guard +
// row update; entering applied/dismissed stamps applied_at/dismissed_at (per 01: set on entry)
function getCriteria(): Promise<Criteria>;                        // defined in 01
function updateCriteria(value: unknown): Promise<Criteria>;       // defined in 01: zod-parses; throws, writes nothing on invalid
// NEW exports this spec adds to the 01 seam (extensions — not parallel replacements):
function assertTransition(from: Status, to: Status): void;        // pure guard; throws the same InvalidTransitionError
function listJobs(f: { status?: Status; difficulty?: Difficulty; roleCategory?: RoleCategory;
  source?: Source; sort: 'match_score' | 'first_seen_at'; page: number })
  : Promise<{ rows: Job[]; total: number }>;                      // page size fixed at 50
```

- **Pages** (one shared nav bar linking `/jobs`, `/criteria`, `/runs`; nothing else):
  - `/jobs` — table with filters (`status`, `difficulty`, `role_category`, `source`), sort by `match_score` (desc) or `first_seen_at` (desc), pagination of 50, inline Queue/Dismiss actions per row. Filter/sort/page state lives in the URL query string so a filtered view can be reloaded or bookmarked.
  - `/jobs/[id]` — `description`, `match_reasons`, `difficulty_reasons`, application questions read from `raw` when present (absent `raw.questions` renders a plain "none captured" line, not an error), links to `url` and `apply_url`, status buttons, and a `notes` textarea persisted to `jobs.notes` (notes save independently of status; saving notes never changes `status`).
  - `/criteria` — form bound to `criteria.value` (single row, `id = 1`), validated with the shared zod schema from `packages/core`. Invalid input shows per-field errors and writes nothing. This is where `role_priorities` keywords, `locations`, and `notify_min_score` get tuned.
  - `/runs` — `crawl_runs` history, newest first: `started_at`, `finished_at`, `trigger`, `ok`, `notified_count`, and per-source `stats` (`fetched`, `new`, `updated`, `errors[]`) rendered so a broken source is visible without ssh-ing into the crawler Mac. A run with any non-empty `errors[]` shows those error strings verbatim.
- **Status buttons on `/jobs/[id]`** — enabled exactly when the contract's status machine allows the transition from the row's current `status`; everything else is disabled:

  | current status | enabled buttons (target) |
  |---|---|
  | `new` | Queue (`queued`), Dismiss (`dismissed`) |
  | `notified` | Queue (`queued`), Dismiss (`dismissed`) |
  | `queued` | Applied (`applied`), Dismiss (`dismissed`) |
  | `applied` | Un-do (`queued`) |
  | `dismissed` | Un-do (`queued`) |
  | `expired` | none |

  Buttons are convenience only — the server action re-checks via `assertTransition`, so a stale page cannot force an illegal write (S4).
- **Test seam:** session lookup is wrapped in `apps/admin/lib/auth.ts` as `getSessionEmail(): Promise<string | null>` so integration tests can stub the session without a live Auth0 tenant. Middleware redirect behavior (S1) is tested against the real Auth0 middleware with no session cookie.
- **Test database:** vitest integration tests run against the Supabase local stack (`supabase start`) with `supabase/migrations` applied; `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` point at it. Each test seeds and cleans its own rows.
- **Fixture:** job rows seeded for detail-page and status tests take their `raw` (including application questions) from `apps/crawler/test/fixtures/greenhouse/job-with-questions.json` — a real Greenhouse `questions=true` payload. **Capturing that real payload is implementation task #1**; do not hand-write it.
- **Non-goals (personal-use scale, one user):** no multi-tenancy, no roles/permissions beyond the allowlist, no audit log, no realtime updates, no caching layer, no mobile layout work beyond whatever the default table markup gives. Do not build any of these.

## 3. Black-Box Test Cases

All scenarios live in `apps/admin/test/` and run under `pnpm test`. `ADMIN_ALLOWED_EMAILS=admin@superapps.com` in the test env unless stated otherwise.

Harness notes (apply to every scenario):
- Each scenario seeds its own rows with distinct `(source, external_id)` pairs and deletes them afterward; scenarios pass when run alone or in any order.
- "Zero data-layer calls" is asserted with a vitest spy on the `packages/core` entry points, not by inspecting logs.
- Every Then clause is checked by an assertion on an HTTP status, a returned value, or a SQL read like:

```sql
select status, applied_at, dismissed_at, notes from jobs where id = $1;
```

No scenario relies on visual inspection.

### S1 — Unauthenticated request redirects to Auth0 login (error case)
- **Given** the admin app is running with Auth0 middleware configured and the request carries no Auth0 session cookie
- **When** the client requests `GET /jobs`
- **Then** the response status is 302 or 307, and the `Location` header path is the login route mounted by `@auth0/nextjs-auth0` (`/auth/login`), with a `returnTo` for `/jobs`
- **And** no query against the `jobs` table is executed (assert via a spy on the data layer: zero calls).

### S2 — Authenticated but non-allowlisted email gets 403 (error case)
- **Given** `getSessionEmail()` resolves to `"intruder@example.com"` and `ADMIN_ALLOWED_EMAILS=admin@superapps.com`
- **When** the client requests `GET /jobs`
- **Then** the response status is exactly 403 and the body contains the text `Not authorized`
- **And** zero data-layer calls are made.

### S3 — Queue on a new job persists `queued` (happy path)
- **Given** an allowlisted session and a seeded `jobs` row with `status = 'new'` (seed `raw` from `apps/crawler/test/fixtures/greenhouse/job-with-questions.json`)
- **When** the Queue action on `/jobs` is invoked for that row (server action calling `applyStatusTransition(id, 'queued')`, which returns `void`; the action re-reads the row to render the updated state)
- **Then** `select status from jobs where id = $1` returns `'queued'`
- **And** the same SQL read shows `applied_at` and `dismissed_at` still null.

### S4 — Invalid transition is rejected and the row is unchanged (error case)
- **Given** an allowlisted session and a seeded job with `status = 'dismissed'`, `dismissed_at` set, `notes = 'keep me'`
- **When** the Applied action is invoked for that job (`applyStatusTransition(id, 'applied')`)
- **Then** the action rejects with `InvalidTransitionError` (`from: 'dismissed'`, `to: 'applied'`) and the UI path surfaces an error message rather than a success state
- **And** re-reading the row shows `status = 'dismissed'`, `applied_at` is null, `dismissed_at` and `notes` are byte-for-byte unchanged.

### S5 — Criteria edit persists and reads back (happy path)
- **Given** an allowlisted session and the `criteria` row holding the contract's default value (`notify_min_score = 60`)
- **When** the `/criteria` form is submitted with `notify_min_score` changed to `55` and a keyword `"react native developer"` appended to the `react-native` entry in `role_priorities` (payload valid per the shared zod schema)
- **Then** the submit succeeds and `select value from criteria where id = 1` shows `notify_min_score = 55` and the new keyword present
- **And** a subsequent `getCriteria()` returns exactly the submitted value, and `updated_at` is greater than its pre-test value.

### S6 — Invalid criteria input shows field errors and writes nothing (edge case)
- **Given** an allowlisted session and the `criteria` row holding a known value `V`
- **When** the `/criteria` form is submitted with `notify_min_score = "high"` (non-numeric) and `role_priorities = []`'s first entry missing `category`
- **Then** the response contains at least one per-field error keyed by the zod issue path (e.g. `notify_min_score`), no thrown 500
- **And** `select value from criteria where id = 1` still equals `V` and `updated_at` is unchanged.

### S7 — `/jobs` status filter returns only matching rows, 50 per page (edge case)
- **Given** an allowlisted session and 55 seeded jobs with `status = 'new'`, 3 with `status = 'queued'`, 2 with `status = 'dismissed'`
- **When** `listJobs({ status: 'queued', sort: 'first_seen_at', page: 1 })` is called via the `/jobs` filter
- **Then** it returns `total = 3` and 3 rows, every row having `status = 'queued'` and none of the seeded `new`/`dismissed` ids present
- **And when** `listJobs({ status: 'new', sort: 'first_seen_at', page: 1 })` then `page: 2` are called, **then** page 1 returns exactly 50 rows, page 2 returns exactly 5, with no id appearing on both pages.

### S8 — Service key and public Supabase vars never reach the client bundle (build-time assertion)
- **Given** `apps/admin` is built with `SUPABASE_SERVICE_ROLE_KEY=sk_canary_jobscout_do_not_ship` in the build env
- **When** the bundle-safety test scans every file under `apps/admin/.next/static/` and greps the `apps/admin` source tree
- **Then** the canary string `sk_canary_jobscout_do_not_ship` appears in zero files under `.next/static/`
- **And** the pattern `NEXT_PUBLIC_SUPABASE` appears in zero files under `apps/admin/` (source and build output). The bundle-safety test assembles that needle at runtime (`'NEXT_PUBLIC_' + 'SUPABASE'`) so the literal never appears anywhere under `apps/admin/`, including the test's own source
- **And** the env-var table in `apps/admin/README.md` lists only the eight server-side vars from §2.

## 4. Definition of Done

- [ ] `test -s apps/crawler/test/fixtures/greenhouse/job-with-questions.json` exits 0 (real captured Greenhouse payload — implementation task #1)
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm build` exits 0 (includes `apps/admin` Next.js production build)
- [ ] `pnpm test` exits 0 with scenarios S1–S8 present and passing (vitest, `apps/admin/test/`)
- [ ] `SUPABASE_SERVICE_ROLE_KEY=sk_canary_jobscout_do_not_ship pnpm --filter admin build && ! grep -R "sk_canary_jobscout_do_not_ship" apps/admin/.next/static && ! grep -R "NEXT_PUBLIC_SUPABASE" apps/admin` exits 0 — the literal may not appear anywhere under `apps/admin`, tests included; the S8 test builds the needle via string concatenation so this grep can pass
