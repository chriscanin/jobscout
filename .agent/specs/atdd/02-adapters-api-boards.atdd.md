# ATDD Specification: API board adapters (Greenhouse, Lever, Ashby)

## 1. Problem Statement

* **Context:** jobscout's crawl pipeline (CONTRACT.md §Crawl pipeline) runs source adapters to
  produce `RawJob[]`, which the pipeline then normalizes and upserts into `jobs`. The `companies`
  table stores which ATS each company uses (`ats`) and its board identifier (`board_token`).
  Greenhouse, Lever, and Ashby all publish official, keyless JSON board APIs.
* **The Gap:** No adapters exist for these three APIs. They are the primary job intake for the
  whole system — without them the pipeline has no input, and the difficulty classifier has no
  Greenhouse application-questions data to apply rule 1 of the rubric.
* **Impact:** Zero rows in `jobs`, nothing to classify, nothing to notify. The Greenhouse
  `questions=true` capture is also the only deterministic path to `difficulty = easy | medium`;
  skipping it forces every job through the LLM fallback (slower, costs money).

## 2. System Constraints & Environment

* **Runtime:** TypeScript, Node 22, pnpm workspaces. Adapters live in `apps/crawler`; the
  `SourceAdapter` and `RawJob` types come from `packages/core` (CONTRACT.md §Source adapter interface).
* **Tests:** vitest. Commands: `pnpm test`, `pnpm typecheck`, `pnpm build`. Tests make no live
  network calls: the `CrawlCtx` fetch helper is constructed over a mocked HTTP transport, and
  backoff waits use vitest fake timers.
* **Interface (from the contract, plus the shared `recordError` channel adopted from spec 03):**

  ```ts
  interface SourceAdapter {
    source: Source;
    fetchJobs(ctx: CrawlCtx): Promise<RawJob[]>;
  }
  // CrawlCtx provides: criteria, active companies for this source,
  // a fetch helper with politeness + retry built in, a logger
  // (human-readable logging only), and recordError(message: string) —
  // the single channel the pipeline aggregates into
  // crawl_runs.stats[source].errors.
  ```

* **Endpoints (official APIs, no auth):**

  | Adapter | `source` / `atsHint` | Endpoint |
  |---|---|---|
  | Greenhouse | `greenhouse` | `GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs?content=true` (listing); `GET .../jobs/{id}?questions=true` (detail, prescreen-gated) |
  | Lever | `lever` | `GET https://api.lever.co/v0/postings/{board_token}?mode=json` |
  | Ashby | `ashby` | `GET https://api.ashbyhq.com/posting-api/job-board/{board_token}` |

* **Input:** the `companies` rows for this adapter's `ats` with `active = true` and
  `board_token` not null, provided by `CrawlCtx`. `RawJob.company` is the `companies.name`
  of the input row (none of these APIs returns the company display name reliably).
* **Politeness:** all HTTP goes through the `CrawlCtx` fetch helper (≥ 2s spacing per domain,
  3 retries with exponential backoff on 429/5xx). Adapters never call `fetch` directly.
* **Isolation:** one company failing (HTTP error, bad JSON) must not reject `fetchJobs`; the
  error is reported via `ctx.recordError(message)` — the single channel the pipeline aggregates
  into `crawl_runs.stats[source].errors` (the logger is for human-readable logging only) — and
  remaining companies are still processed.
* **Greenhouse prescreen:** the `questions=true` detail fetch is expensive (one request per job),
  so it only runs for jobs whose lowercase title contains at least one keyword from
  `criteria.value.role_priorities[].keywords`. The prescreen gates the detail fetch only — every
  listed job is still returned in `RawJob[]` (scoring happens downstream in the classifier).
* **Lever limitation (plain statement):** the Lever postings API does not expose application
  questions. `RawJob.questions` stays `undefined` for every Lever job, and difficulty for Lever
  jobs falls to the classifier's LLM fallback (rubric rule 3). Same applies to Ashby's job-board API.
* **Fixtures — implementation task #1:** before writing any adapter code, capture real payloads
  from live boards (e.g. the `mattermost` Greenhouse board). These are the **canonical shared
  capture paths** (one path per real capture, shared across specs per the fixture appendix in
  CONTRACT.md) — if a capture already exists at its canonical path, reuse it; never re-capture
  the same endpoint under a different name:
  * `apps/crawler/test/fixtures/greenhouse/mattermost-board.json` — `mattermost` listing with `content=true`
  * `apps/crawler/test/fixtures/greenhouse/mattermost-job-5238290008.json` — job 5238290008 with `questions=true`
  * `apps/crawler/test/fixtures/lever/board-postings.json` — a real Lever board, `mode=json`
  * `apps/crawler/test/fixtures/ashby/job-board.json` — a real Ashby board
  Each fixture directory gets a `SOURCE.md` recording the exact URL and capture date. The field
  mappings below state the expected payload shape; **the captured fixture is authoritative** — if
  a real payload disagrees, correct the mapping table here first, then implement.

* **Field mapping (contract statements, asserted in Scenarios 1, 4, 5):**

  | RawJob field | Greenhouse (listing job) | Lever (posting) | Ashby (job) |
  |---|---|---|---|
  | `externalId` | `String(id)` | `id` | `id` |
  | `url` | `absolute_url` | `hostedUrl` | `jobUrl` |
  | `applyUrl` | `absolute_url` | `applyUrl` | `applyUrl` |
  | `title` | `title` | `text` | `title` |
  | `company` | input row `companies.name` | same | same |
  | `location` | `location.name` | `categories.location` | `location` |
  | `postedAt` | `first_published` | `createdAt` (epoch ms → ISO 8601) | `publishedAt` |
  | `description` | `content` | `descriptionPlain` | `descriptionHtml` |
  | `atsHint` | `'greenhouse'` | `'lever'` | `'ashby'` |
  | `raw` | listing job object, merged with detail payload when fetched | posting object | job object |

  `postedAt` is always an ISO 8601 string in the returned `RawJob` regardless of the source format.

## 3. Black-Box Test Cases (The "Green" Gates)

Shared setup for all scenarios: a test `CrawlCtx` built with (a) the default criteria value from
CONTRACT.md §Matching criteria, (b) a list of company rows, (c) the real fetch helper wired to a
mocked HTTP transport that records every request URL and returns canned responses, (d) a
`recordError` spy and a no-op logger. Gate class for every scenario: static (`pnpm` only, no MCP tooling).

### Scenario 1: Greenhouse listing parses to correctly mapped RawJobs (happy path)
* **Given:** one active company row (`name: 'Mattermost'`, `ats: 'greenhouse'`,
  `board_token: 'mattermost'`) and the transport serving
  `apps/crawler/test/fixtures/greenhouse/mattermost-board.json` for the listing URL
* **When:** `greenhouseAdapter.fetchJobs(ctx)` resolves
* **Then:** the result length equals the fixture's `jobs.length`; every RawJob has
  `source === 'greenhouse'`, `atsHint === 'greenhouse'`, `company === 'Mattermost'`; and for the
  first fixture job, `externalId`, `url`, `title`, `location`, and `postedAt` equal the mapped
  fixture fields per the table in §2 (deep-equal assertions against values read from the fixture)

### Scenario 2: Prescreen-passing Greenhouse job gets its questions captured (happy path)
* **Given:** the Scenario 1 setup, where the fixture contains at least one job whose title matches
  a criteria keyword (e.g. contains "mobile engineer"), and the transport serves
  `apps/crawler/test/fixtures/greenhouse/mattermost-job-5238290008.json` for that job's
  `jobs/{id}?questions=true` URL
* **When:** `greenhouseAdapter.fetchJobs(ctx)` resolves
* **Then:** the RawJob for that job has `questions` deep-equal to the detail fixture's `questions`
  array, and its `raw` contains the detail payload (so `jobs.raw` retains the questions downstream)

### Scenario 3: Prescreen prevents detail fetches for non-matching titles (edge case)
* **Given:** the Scenario 1 setup, where the listing fixture contains at least one job whose title
  matches no criteria keyword (e.g. "Senior Accountant")
* **When:** `greenhouseAdapter.fetchJobs(ctx)` resolves
* **Then:** the transport recorded exactly one listing request per company, plus detail requests
  (`questions=true`) **only** for the prescreen-passing job ids — zero requests contain the
  non-matching job's id; the non-matching job is still present in the result with
  `questions === undefined`

### Scenario 4: Lever postings parse, with questions always undefined (happy path)
* **Given:** one active company row (`ats: 'lever'`) and the transport serving
  `apps/crawler/test/fixtures/lever/board-postings.json`
* **When:** `leverAdapter.fetchJobs(ctx)` resolves
* **Then:** the result length equals the fixture array length; the first RawJob's `externalId`,
  `url`, `applyUrl`, `title`, `location` match the mapped fixture fields; `postedAt` is the ISO
  8601 conversion of the fixture's `createdAt`; and **every** RawJob has `questions === undefined`
  and `atsHint === 'lever'`

### Scenario 5: Ashby job board parses to correctly mapped RawJobs (happy path)
* **Given:** one active company row (`ats: 'ashby'`) and the transport serving
  `apps/crawler/test/fixtures/ashby/job-board.json`
* **When:** `ashbyAdapter.fetchJobs(ctx)` resolves
* **Then:** the result length equals the fixture's `jobs.length`; the first RawJob's `externalId`,
  `url`, `title`, `location`, `postedAt` match the mapped fixture fields; `atsHint === 'ashby'`;
  `questions === undefined`

### Scenario 6: 404 board token skips that company, others still processed (error case)
* **Given:** two active Greenhouse company rows — `bad-token` (transport returns HTTP 404 for its
  listing URL) and `mattermost` (transport serves the listing fixture)
* **When:** `greenhouseAdapter.fetchJobs(ctx)` resolves (it must not reject)
* **Then:** the result contains only Mattermost jobs; `ctx.recordError` was called exactly once
  with a message containing both `bad-token` and `404`; and the transport recorded exactly one
  request to the `bad-token` URL (404 is not a retryable status — no backoff retries)

### Scenario 7: 429 succeeds after backoff retry (edge case)
* **Given:** one active Lever company row; the transport returns HTTP 429 for the first request to
  the postings URL and the postings fixture (HTTP 200) for the second; vitest fake timers active
* **When:** `leverAdapter.fetchJobs(ctx)` resolves (timers advanced past the backoff delay)
* **Then:** the transport recorded exactly two requests to the postings URL, and the result parses
  identically to Scenario 4 — `ctx.recordError` is never called for this company

### Scenario 8: Malformed JSON from one company does not abort the others (error case)
* **Given:** two active Ashby company rows — company A's listing URL returns HTTP 200 with the
  body `"<!DOCTYPE html><html>maintenance</html>"` (not JSON), company B's returns the Ashby fixture
* **When:** `ashbyAdapter.fetchJobs(ctx)` resolves (it must not reject)
* **Then:** the result contains exactly company B's jobs; `ctx.recordError` was called exactly
  once with a message containing company A's `board_token`; company B's jobs are unaffected

## 4. Definition of Done

- [ ] All four real fixtures plus `SOURCE.md` provenance files exist and parse as JSON:
      `node -e "const fs=require('fs');['greenhouse/mattermost-board.json','greenhouse/mattermost-job-5238290008.json','lever/board-postings.json','ashby/job-board.json'].forEach(f=>JSON.parse(fs.readFileSync('apps/crawler/test/fixtures/'+f,'utf8')));['greenhouse','lever','ashby'].forEach(d=>fs.accessSync('apps/crawler/test/fixtures/'+d+'/SOURCE.md'))"`
      exits 0
- [ ] All 8 scenarios above are implemented as automated vitest tests and `pnpm test` exits 0
      (this also covers regression: the full workspace suite runs, not just the adapter tests)
- [ ] `pnpm typecheck` exits 0 (adapters satisfy the `SourceAdapter` / `RawJob` types from
      `packages/core` exactly as written in CONTRACT.md)
- [ ] Grep proves no direct network calls bypass the CrawlCtx helper:
      `grep -rnE '(^|[^.a-zA-Z])fetch\(|node-fetch|undici' apps/crawler/src/adapters/ | grep -v test`
      produces no output (exit code 1) — the pattern catches bare global `fetch(` while allowing `ctx.fetch(`
