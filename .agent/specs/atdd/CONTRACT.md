# jobscout — Shared Contract (canonical)

Personal AI job search engine for one user (Chris). It crawls job sources on a schedule, stores matching jobs in Supabase, ranks each job by how hard the application is (easy / medium / hard), posts new matches to a Discord channel, and exposes an Auth0-gated admin app for working the queue. **No auto-apply** — the system queues jobs up; Chris fills them out himself.

Every spec in this directory conforms to this contract. If a spec conflicts with this file, this file wins.

## Runtime plan

Development and initial operation happen on Chris's main Mac. When stable, the crawler moves to a dedicated always-on Mac. Therefore: **all state lives in Supabase**, the crawler machine is disposable, and setup on a new machine is mechanical (see §Portability).

## Stack (decided — do not revisit)

- TypeScript, Node 22, pnpm workspaces:
  - `apps/crawler` — CLI + standing loop (runs on a Mac via launchd)
  - `apps/admin` — Next.js (App Router) admin, deployed to Vercel
  - `packages/core` — shared types, zod schemas, difficulty rubric, Supabase data layer
  - `supabase/migrations` — SQL migrations
  - `ops/` — launchd plist + install script
- Supabase Postgres (hosted). Both the crawler and admin talk to it over a **direct Postgres connection** using the `pg` client and the connection string in `SUPABASE_DB_URL` (server-side only — never shipped to the browser). We do not use PostgREST/supabase-js in v1, because the pipeline needs real SQL (upserts with `ON CONFLICT`, `pg_try_advisory_lock`). The crawler must use a **session-mode** connection (direct :5432 or the session pooler) so advisory locks hold for a run; the admin may use the transaction pooler.
- Auth0 for admin login, with an email allowlist.
- Discord incoming webhook for notifications (no bot).
- Anthropic API for classification (claude-haiku-4-5 default, claude-sonnet-4-6 for ambiguous cases) and for web-search-based discovery.
- Tests: vitest, with fixtures captured from real sources. Commands: `pnpm test`, `pnpm typecheck`, `pnpm build`.
- Toolchain: Node 22 (this repo's `.nvmrc`), pnpm workspaces. On the current dev Mac, Node 22 is available via nvm at `~/.nvm/versions/node/v22.21.1/bin` — activate it before running any pnpm/tsx command. TypeScript is consumed as source: packages are ESM, run via `tsx`, tested via `vitest`, type-checked via `tsc --noEmit`; only the admin has a real build step (Next). Package names: `@jobscout/core`, `@jobscout/crawler`, `@jobscout/admin`.
- Docker-free testing: the data-layer and pipeline tests run against **PGlite** (`@electric-sql/pglite`), an in-process Postgres — no Docker, no Supabase CLI. The SAME SQL files in `supabase/migrations/` are applied to a fresh PGlite database by a test helper, and to the real Supabase DB by `pnpm db:push` (a tiny `pg` runner that executes the migration files in filename order). `packages/core` exposes a `Db` abstraction with one method — `query(text, params) => Promise<{ rows }>` — satisfied by both `pg.Pool` (production, from `SUPABASE_DB_URL`) and PGlite (tests).

## Environment variables

- Crawler (`apps/crawler/.env`): `SUPABASE_DB_URL` (direct/session-mode Postgres connection string), `ANTHROPIC_API_KEY`, `DISCORD_WEBHOOK_URL`
- Admin (Vercel env): `SUPABASE_DB_URL` (transaction-pooler string is fine here), `AUTH0_SECRET`, `AUTH0_BASE_URL`, `AUTH0_ISSUER_BASE_URL`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `ADMIN_ALLOWED_EMAILS` (comma-separated)
- Tests: none required — PGlite runs in-process.
- Supersession note: earlier specs mention `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`; those are replaced by `SUPABASE_DB_URL`. The security rule they state still holds verbatim: no server secret (the DB URL, Auth0 secrets) may ever reach the client bundle, and there are no `NEXT_PUBLIC_` database vars.

## Enums

Stored as `text` with CHECK constraints (not Postgres enums), so adding values is a one-line migration.

- `source`: `greenhouse | lever | ashby | caljobs | indeed | ziprecruiter | discovery`
- `ats`: `greenhouse | lever | ashby | workday | icims | taleo | successfactors | oracle | adp | brassring | other | unknown`
- `role_category`: `react-native | react | frontend | fullstack | other`
- `difficulty`: `easy | medium | hard | unknown`
- `status`: `new | notified | queued | applied | dismissed | expired`

## Database schema

### `jobs`
- `id` uuid pk default gen_random_uuid()
- `source` text not null (enum above)
- `external_id` text not null — **unique (source, external_id)**
- `company_id` uuid null references companies(id)
- `url` text not null (the posting page), `apply_url` text null
- `title` text not null, `company` text not null
- `location` text null, `is_remote` boolean null
- `salary_raw` text null, `salary_min` integer null, `salary_max` integer null (USD/year)
- `description` text null (truncate at 20,000 chars)
- `posted_at` timestamptz null
- `first_seen_at` timestamptz not null default now(), `last_seen_at` timestamptz not null default now()
- `role_category` text null, `match_score` integer null (0–100), `match_reasons` text[] null
- `ats` text not null default 'unknown', `difficulty` text not null default 'unknown', `difficulty_reasons` text[] null
- `status` text not null default 'new'
- `notes` text null (user notes from admin)
- `dedup_hash` text not null, indexed — sha256 of normalized `company + '|' + title + '|' + location` (lowercase, punctuation stripped, whitespace collapsed, null location → empty string)
- `missing_streak` integer not null default 0 (consecutive crawls where the source no longer lists this job)
- `notified_at`, `applied_at`, `dismissed_at` timestamptz null
- `raw` jsonb null (source payload, incl. application questions when available)

### `companies`
- `id` uuid pk, `name` text not null
- `ats` text not null (enum above), `board_token` text null (Greenhouse board token / Lever site slug / Ashby org slug), `careers_url` text null
- `discovered_via` text not null (`seed | web-search | manual`)
- `active` boolean not null default true, `last_crawled_at` timestamptz null, `created_at` timestamptz default now()
- unique (ats, board_token)

### `crawl_runs`
- `id` uuid pk, `started_at` / `finished_at` timestamptz, `trigger` text (`launchd | manual | loop`)
- `stats` jsonb — per-source `{ fetched, new, updated, errors: string[] }`
- `notified_count` integer, `ok` boolean

### `criteria` (single row)
- `id` smallint pk check (id = 1), `value` jsonb not null, `updated_at` timestamptz

## Status machine

- `new → notified` — notifier, after a successful Discord post
- `new | notified → queued | dismissed` — admin
- `queued → applied | dismissed` — admin
- `applied | dismissed → queued` — admin (undo)
- `new | notified → expired` — crawler, when `missing_streak >= 2`

No other transitions. The data layer in `packages/core` enforces this; invalid transitions throw.

## Difficulty rubric (the user's definition, formalized)

- **easy** — apply in place with only standard fields: name, email, phone, resume, and links (LinkedIn / website / location). No custom or personal questions, no account. Reference example: Greenhouse boards like https://job-boards.greenhouse.io/mattermost/jobs/5238290008.
- **medium** — same apply-in-place style, but with custom/personal questions (why-us essays, salary expectations, visa status, screening questions).
- **hard** — requires creating an account or logging into an external ATS portal (Workday, iCIMS, Taleo, SuccessFactors, Oracle HCM, ADP, BrassRing), or manually re-entering work history. Reference example: Ulta Beauty's careers portal.
- **unknown** — could not determine; retried on later runs and visible in admin.

Deterministic rules first, LLM fallback second:
1. Greenhouse: fetch the job with `questions=true`. Standard question set = `{first_name, last_name, email, phone, resume, cover_letter, linkedin, website, location}`. All questions within the set → **easy**; anything beyond → **medium**.
2. `apply_url` host matches a `HARD_ATS_DOMAINS` list (`myworkdayjobs.com`, `icims.com`, `taleo.net`, `successfactors.com`, `oraclecloud.com`, `adp.com`, `brassring.com`) → **hard** (no LLM call).
3. Otherwise: fetch the apply page HTML and ask Claude to classify per this rubric, returning `difficulty` + 1–3 `difficulty_reasons`.

## Matching criteria (stored in `criteria.value`, editable in admin)

Default value:

```json
{
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
}
```

Rules:
- Priority 1 = React Native / mobile. Priority 2 = React, frontend. Priority 3 = fullstack/backend-leaning.
- Priority-3 jobs are only notified when `difficulty = easy` (user: "if it's easy enough we can still apply").
- **Notify when:** `status = new` AND `match_score >= notify_min_score` AND (priority ≤ 2 OR difficulty = easy) AND no already-notified job shares the same `dedup_hash`.
- Jobs below threshold stay `new` (not notified) — lowering the threshold in admin makes the next run pick them up.

## Source adapter interface (`packages/core`)

```ts
type RawJob = {
  source: Source; externalId: string; url: string; applyUrl?: string;
  title: string; company: string; location?: string; salaryRaw?: string;
  description?: string; postedAt?: string; atsHint?: Ats;
  questions?: unknown; raw: unknown;
};
interface SourceAdapter {
  source: Source;
  fetchJobs(ctx: CrawlCtx): Promise<RawJob[]>;
}
// CrawlCtx provides: criteria, active companies for this source,
// a fetch helper with politeness + retry built in, and a logger.
```

## Crawl pipeline (fixed order)

load criteria → sync the seed companies file (`apps/crawler/seeds/companies.seed.json`) into `companies` → run adapters (each isolated; one failing must not kill the run) → normalize + upsert (`(source, external_id)` conflict updates `last_seen_at` + mutable fields, resets `missing_streak`) → increment `missing_streak` for jobs a source no longer lists → classify unclassified jobs (match score, then difficulty) → expire (`missing_streak >= 2` and status new/notified) → notify → record `crawl_runs` row. Single-flight enforced with a Postgres advisory lock (portable across machines).

## Politeness / scraping rules (personal-use scale)

- Normal browser UA for HTML fetches; ≥ 2s spacing per domain; ≤ 3 search-result pages per scraped source per run.
- Respect robots.txt for generic discovery crawling. Official JSON board APIs (Greenhouse/Lever/Ashby) are used as documented.
- Never bypass CAPTCHAs or logins in v1. If a source blocks us: record the error in `crawl_runs.stats`, skip the source, keep the run going.
- v2 (out of scope for these specs): LinkedIn / Upwork / Toptal via logged-in browser automation on the dedicated Mac.

## Portability (Mac #1 → Mac #2)

All state lives in Supabase; logs go to `~/Library/Logs/jobscout/`. New machine setup: clone repo → copy `.env` → `pnpm install` → `pnpm doctor` green → `ops/install-launchd.sh`. Decommission the old machine with `launchctl unload`. Nothing else to migrate.
