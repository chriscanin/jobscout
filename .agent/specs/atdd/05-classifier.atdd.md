# ATDD Specification: Classifier (role match scoring + application difficulty)

Conforms to `.agent/specs/atdd/CONTRACT.md`. If anything below disagrees with the contract, the contract wins.

## 1. Problem Statement

**Context.** After the upsert step of the crawl pipeline, rows in `jobs` arrive with `match_score` NULL and `difficulty` `'unknown'`. Nothing downstream can act on them: the notifier gates on `match_score >= notify_min_score` and (for priority-3 roles) `difficulty = 'easy'`, and the admin queue sorts on both columns.

**The Gap.** There is no classify step. Two things are missing: (A) `scoreMatch` — score each new job 0–100 against the criteria in the `criteria` table and assign a `role_category`; (B) `rankDifficulty` — rank each job `easy | medium | hard` per the contract rubric. Both must be cheap (this runs on a schedule, many times a day) and must not kill the run when the Anthropic API fails.

**Impact.** Without this seam, every crawled job sits invisible at `status = 'new'` forever. With it, Chris gets a Discord ping only for jobs that match his roles and, for backend-leaning ones, only when the application is easy enough to be worth it.

## 2. System Constraints & Environment

- TypeScript, Node 22, pnpm workspaces. Logic lives in `apps/crawler` (step of the crawl pipeline); shared types, zod schemas, and the rubric constants live in `packages/core`. Tests: vitest (`pnpm test`, `pnpm typecheck`, `pnpm build`).
- Postgres via Supabase, service-role key. Env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY` (from `apps/crawler/.env`).
- Models are fixed by the contract: `claude-haiku-4-5` default, `claude-sonnet-4-6` only for re-scoring the ambiguous 40–70 band. Exactly these ID strings.
- Pipeline order is fixed: classify runs after upsert and `missing_streak` handling, before expire/notify. Match score first, then difficulty.
- Row selection:
  - `scoreMatch`: `SELECT * FROM jobs WHERE match_score IS NULL`
  - `rankDifficulty`: `SELECT * FROM jobs WHERE difficulty = 'unknown' AND match_score > 0` (jobs prescreened to 0 are never notified, so they are never ranked — this keeps LLM and page-fetch cost near zero for junk)
- `scoreMatch` order of operations:
  1. Deterministic prescreen (pure function, no I/O): lowercase `title + ' ' + description`. If no keyword from any `criteria.value.role_priorities[].keywords` appears in it, OR any `criteria.value.exclude_keywords` entry appears in the lowercased **title**, set `match_score = 0`, `role_category = 'other'`, `match_reasons = ['prescreen:exclude:<keyword>']` or `['prescreen:no-keyword-match']`. No LLM call.
  2. Survivors are batched, **at most 20 jobs per request**, to `claude-haiku-4-5`. The prompt contains the criteria JSON (verbatim `criteria.value`) plus, per job, its `id`, `title`, `company`, `location`, and `description` truncated to 2,000 chars. The model must return, per job id: `role_category` (contract enum), `match_score` 0–100 integer, `match_reasons` (1–3 short strings).
  3. Any job whose haiku score lands in **40–70 inclusive** is re-scored **once** by `claude-sonnet-4-6` (same prompt shape, single job or small batch); the sonnet result replaces the haiku result. Never a third pass.
- `rankDifficulty` order of operations, exactly per the contract rubric:
  1. **Greenhouse questions rule (deterministic, no LLM).** If `source = 'greenhouse'` and `raw.questions` is present (adapter fetched the job with `questions=true`): a question is standard when every one of its field names is in `{first_name, last_name, email, phone, resume, cover_letter, linkedin, website, location}`. All questions standard → `easy`. Any question beyond the set → `medium`.
  2. **`HARD_ATS_DOMAINS` rule (deterministic, no LLM).** If the `apply_url` hostname equals or is a subdomain of any of `myworkdayjobs.com, icims.com, taleo.net, successfactors.com, oraclecloud.com, adp.com, brassring.com` → `hard`. No page fetch.
  3. **LLM fallback.** Otherwise fetch the apply page HTML through the `CrawlCtx` fetch helper (browser UA, ≥ 2s spacing per domain) and ask `claude-haiku-4-5` to classify per the rubric, returning `difficulty` (must be `easy | medium | hard`) and 1–3 `difficulty_reasons`.
- **Rubric grounding (the user's own reference examples, verbatim in the fallback prompt):** a Greenhouse board like the Mattermost posting (https://job-boards.greenhouse.io/mattermost/jobs/5238290008 — apply in place, no personal questions) = **easy**; the same style board but with personal questions (why-us essays, salary expectations, visa status, screening questions) = **medium**; a portal like Ulta Beauty's careers site where you must create an account and re-enter work history = **hard**.
- Failure policy: an Anthropic or fetch error must never throw out of the classify step. The affected jobs keep `match_score` NULL / `difficulty` `'unknown'` (they are retried next run), the error string is collected, and the pipeline writes it into the `crawl_runs.stats` JSON under a `classifier` key, alongside the per-source entries: `stats.classifier = { scored: n, ranked: n, errors: string[] }` (this key must be added to CONTRACT.md's `crawl_runs.stats` shape, 01's `recordCrawlRun` signature, and 07's crawl_runs semantics — the runner spec owns writing the row).

Interface (contract statement, `packages/core`):

```ts
type ScoreOutcome = { jobId: string; roleCategory: RoleCategory; matchScore: number; matchReasons: string[] };
type DifficultyOutcome = { jobId: string; difficulty: 'easy' | 'medium' | 'hard'; difficultyReasons: string[] };

interface ClassifierDeps {
  anthropic: Pick<Anthropic, 'messages'>;          // injected; mocked in every test below
  fetchHtml: (url: string) => Promise<string>;     // CrawlCtx fetch helper, politeness built in
}

function prescreen(job: JobRow, criteria: Criteria): { excluded: true; reason: string } | { excluded: false };
async function scoreMatch(jobs: JobRow[], criteria: Criteria, deps: ClassifierDeps):
  Promise<{ outcomes: ScoreOutcome[]; errors: string[] }>;
async function rankDifficulty(jobs: JobRow[], deps: ClassifierDeps):
  Promise<{ outcomes: DifficultyOutcome[]; errors: string[] }>;
```

Persistence (contract statement — outcomes are written per job, so a mid-batch crash loses nothing already written and unwritten jobs are simply retried next run):

```sql
UPDATE jobs SET role_category = $2, match_score = $3, match_reasons = $4
 WHERE id = $1 AND match_score IS NULL;

UPDATE jobs SET difficulty = $2, difficulty_reasons = $3
 WHERE id = $1 AND difficulty = 'unknown';
```

**Cost note.** With the prescreen, a typical run classifies at haiku prices ($1/M input, $5/M output): ~40 survivors ≈ 2 batch calls ≈ ~70K input + ~4K output ≈ $0.09, plus a handful of difficulty fallbacks (~$0.03) and the occasional sonnet re-score of one ambiguous job (~$0.01). Cents per run; the deterministic rules and the `match_score > 0` gate are what keep it there.

## 3. Black-Box Test Cases

All scenarios run against a test database and a mocked Anthropic client (`deps.anthropic`) and mocked `deps.fetchHtml`. No test makes a real network call. Fixture files hold **real captured payloads** — capturing each fixture from the live source is **implementation task #1** for this seam; do not hand-write them. One exception, because a live model's scores cannot be dictated: the three Anthropic score fixtures may have their numeric score values pinned by **documented, value-only mutation of the real capture** (edit only the score numbers needed to hit the bands below, keep every other byte of the capture, and note the mutation in a comment or sibling README — the same pattern as spec 03's `layout-changed.html`).

Fixtures:

| Path | Real source to capture from |
|---|---|
| `apps/crawler/test/fixtures/greenhouse/mattermost-5238290008-questions.json` | `GET https://boards-api.greenhouse.io/v1/boards/mattermost/jobs/5238290008?questions=true` (standard questions only) |
| `apps/crawler/test/fixtures/greenhouse/custom-questions.json` | Any live Greenhouse job whose payload includes ≥ 1 question beyond the standard set |
| `apps/crawler/test/fixtures/apply-pages/unknown-ats.html` | A live careers apply page whose host is not in `HARD_ATS_DOMAINS` and is not Greenhouse |
| `apps/crawler/test/fixtures/anthropic/score-batch-20.json` | One real `claude-haiku-4-5` Messages API response for a 20-job scoring batch; if any captured score lands in 40–70, pin it outside the band via documented value-only mutation |
| `apps/crawler/test/fixtures/anthropic/score-ambiguous.json` | Real haiku response for two jobs; scores pinned to 55 (job A) and 85 (job B) via documented value-only mutation |
| `apps/crawler/test/fixtures/anthropic/rescore-sonnet.json` | Real `claude-sonnet-4-6` response re-scoring job A; score pinned to 78 via documented value-only mutation |
| `apps/crawler/test/fixtures/anthropic/difficulty-fallback.json` | Real haiku response classifying `unknown-ats.html` per the rubric |

### S1 — Prescreen excludes without any LLM call (error-free edge case)
- **Given** two rows with `match_score` NULL: job A titled `".NET Developer"` (description mentions "react"), job B titled `"Registered Nurse"` whose title+description contain no `role_priorities` keyword; default criteria from the contract
- **When** `scoreMatch([A, B], criteria, deps)` runs
- **Then** job A has `match_score = 0`, `role_category = 'other'`, `match_reasons = ['prescreen:exclude:.net']`; job B has `match_score = 0`, `role_category = 'other'`, `match_reasons = ['prescreen:no-keyword-match']`; and the mocked `anthropic.messages.create` was called **0 times**

### S2 — 20-job batch = exactly one haiku call updating all 20 rows (happy path)
- **Given** 20 rows with `match_score` NULL whose titles each contain a `role_priorities` keyword and no exclude keyword; mocked client returns `fixtures/anthropic/score-batch-20.json` (20 results, all scores outside 40–70)
- **When** `scoreMatch` runs
- **Then** `anthropic.messages.create` was called **exactly once**, with `model = 'claude-haiku-4-5'`, and the request prompt contains the serialized `criteria.value` JSON and all 20 job ids; after persisting outcomes, all 20 rows have non-NULL `match_score` (0–100), a `role_category` in the contract enum, and `match_reasons` of length 1–3

### S3 — Ambiguous 40–70 score is re-scored once by sonnet
- **Given** two surviving jobs; mocked haiku response (`score-ambiguous.json`) scores job A **55** and job B **85**; mocked sonnet response (`rescore-sonnet.json`) scores job A **78**
- **When** `scoreMatch` runs
- **Then** exactly one call used `model = 'claude-haiku-4-5'` and exactly one used `model = 'claude-sonnet-4-6'` (total calls = 2); job A's stored `match_score`, `role_category`, and `match_reasons` equal the sonnet values; job B keeps the haiku values; no third call occurs even though 78 is outside 40–70 only after re-scoring — sonnet output is final regardless of its value

### S4 — Greenhouse standard questions = easy with zero LLM calls
- **Given** a `source = 'greenhouse'` job, `difficulty = 'unknown'`, `match_score = 80`, whose `raw.questions` is loaded from `fixtures/greenhouse/mattermost-5238290008-questions.json`
- **When** `rankDifficulty` runs
- **Then** the row has `difficulty = 'easy'` and `difficulty_reasons = ['greenhouse:standard-questions-only']`; `anthropic.messages.create` was called 0 times and `fetchHtml` was called 0 times

### S5 — Greenhouse custom question = medium, still deterministic
- **Given** a greenhouse job whose `raw.questions` is loaded from `fixtures/greenhouse/custom-questions.json` (≥ 1 field name outside the standard set)
- **When** `rankDifficulty` runs
- **Then** `difficulty = 'medium'`; `difficulty_reasons[0]` matches `/^greenhouse:custom-question:/` and names the first non-standard field; 0 LLM calls, 0 page fetches

### S6 — HARD_ATS_DOMAINS match = hard with zero LLM calls
- **Given** a non-greenhouse job with `apply_url = 'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/12345'`, `difficulty = 'unknown'`, `match_score = 70`
- **When** `rankDifficulty` runs
- **Then** `difficulty = 'hard'` and `difficulty_reasons = ['hard-ats:myworkdayjobs.com']`; 0 LLM calls, 0 page fetches

### S7 — Unknown apply page = LLM fallback invoked once, returns a valid enum value
- **Given** a job with `apply_url` on a host not in `HARD_ATS_DOMAINS` and no `raw.questions`; `fetchHtml` mocked to return `fixtures/apply-pages/unknown-ats.html`; mocked client returns `fixtures/anthropic/difficulty-fallback.json`
- **When** `rankDifficulty` runs
- **Then** `fetchHtml` was called exactly once with the job's `apply_url`; `anthropic.messages.create` was called exactly once with `model = 'claude-haiku-4-5'` and a prompt containing the rubric text (including the strings `"mattermost"` and `"Ulta Beauty"` from the reference examples); the row's `difficulty` is one of `easy | medium | hard` and `difficulty_reasons` has length 1–3

### S8 — Anthropic API failure: job stays unclassified, error recorded, run continues (error case)
- **Given** a scoring batch of 3 jobs where the mocked client **rejects** the haiku call with a 529 `overloaded_error`, and separately 2 jobs needing the difficulty fallback where the first LLM call rejects and the second resolves normally
- **When** `scoreMatch` then `rankDifficulty` run inside the classify step
- **Then** neither function throws; the 3 scoring jobs still have `match_score` NULL; the first fallback job still has `difficulty = 'unknown'` and `difficulty_reasons` NULL; the second fallback job is classified normally; both error strings appear in the returned `errors` arrays; and after the pipeline records the run, the `crawl_runs` row satisfies `stats->'classifier'->'errors'` containing 2 entries with `ok = true` (a classify error alone does not fail the run)

## 4. Definition of Done

- [ ] `pnpm test` passes, including `apps/crawler/test/classifier.test.ts` implementing scenarios S1–S8 with a mocked Anthropic client (no real network)
- [ ] All fixtures exist and are real non-empty captures (score values pinned only via the documented value-only mutations permitted in §3): `test -s apps/crawler/test/fixtures/greenhouse/mattermost-5238290008-questions.json && test -s apps/crawler/test/fixtures/greenhouse/custom-questions.json && test -s apps/crawler/test/fixtures/apply-pages/unknown-ats.html && test -s apps/crawler/test/fixtures/anthropic/score-batch-20.json && test -s apps/crawler/test/fixtures/anthropic/difficulty-fallback.json`
- [ ] Exact model IDs are used in source, not tests only: `grep -rn "claude-haiku-4-5" apps/crawler/src packages/core | grep -q . && grep -rn "claude-sonnet-4-6" apps/crawler/src packages/core | grep -q .`
- [ ] No stray model IDs: `! grep -rnE "claude-(3|opus|sonnet-4-5|haiku-3)" apps/crawler/src packages/core`
- [ ] `pnpm typecheck` and `pnpm build` pass
