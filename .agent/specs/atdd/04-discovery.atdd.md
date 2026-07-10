# ATDD Specification: Discovery (general web crawler for new boards)

## 1. Problem Statement

* **Context:** jobscout crawls a fixed set of companies stored in the `companies` table (seeded from a file, per CONTRACT.md pipeline). The Greenhouse/Lever/Ashby adapters can only fetch jobs for companies that already have a row with an `ats` and `board_token`.
* **The Gap:** Nothing adds new companies. If a company Chris has never heard of posts a React Native job on its Greenhouse board, jobscout will never see it. There is no discovery step that turns "boards that exist on the public web" into `companies` rows.
* **Impact:** The job pool is frozen at the seed list. The whole point of a personal search engine — surfacing jobs Chris didn't know to look for — is missed.

Discovery closes the gap: run a small fixed set of web searches through the Anthropic API `web_search` server tool, extract board identifiers from result URLs, validate each candidate against its public board API, and insert new `companies` rows with `discovered_via = 'web-search'`.

## 2. System Constraints & Environment

* **Runtime:** TypeScript, Node 22, pnpm workspaces. Discovery lives in `apps/crawler` with shared helpers in `packages/core` (per CONTRACT.md stack).
* **Frameworks:** vitest for tests. Fixtures captured from real sources.
* **External dependencies:** Anthropic Messages API with the `web_search` server tool (auth via `ANTHROPIC_API_KEY`); Supabase Postgres via the `packages/core` data layer (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`); public board APIs for validation:
  * greenhouse: `GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs`
  * lever: `GET https://api.lever.co/v0/postings/{site}?mode=json`
  * ashby: `GET https://api.ashbyhq.com/posting-api/job-board/{org}`
* **Search budget:** at most **8** searches per discovery run. The query set is fixed and built from `criteria.value.role_priorities[].keywords` (highest-priority keywords first, truncated at 8). Reference query set with the default criteria:
  1. `site:job-boards.greenhouse.io "react native"`
  2. `site:boards.greenhouse.io react`
  3. `site:jobs.lever.co react native`
  4. `site:jobs.lever.co react`
  5. `site:jobs.ashbyhq.com react native`
  6. `site:jobs.ashbyhq.com frontend`
  7. `react native jobs remote careers` (generic)
  8. `mobile engineer jobs "apply" careers page` (generic)

  Enforce the cap in our wrapper; also pass `max_uses: 8` on the `web_search` tool config as a second guard.

  **Domain scoping caveat:** `site:` operators in query text are not guaranteed to be honored by the search backend. For queries 1–6, pass the target host via the `web_search` tool's `allowed_domains` parameter (the documented scoping mechanism) with the keyword as plain query text; keep the `site:` form only as a readability convention in this table. Extraction must not assume results are scoped — it validates every URL shape regardless of which query produced it.
* **Politeness:** board API validation calls are documented JSON APIs (no robots.txt needed). Fetching any generic (non-API) careers page requires a robots.txt check first, normal browser UA, and ≥ 2s per-domain spacing, via the `CrawlCtx` fetch helper.
* **v1 boundary:** no scraping of arbitrary careers pages. A page with no recognizable ATS becomes an `ats = 'other'` row for manual review in the admin — nothing more.
* **Run placement:** CONTRACT.md's fixed crawl pipeline does not include a discovery step, so discovery does not modify that pipeline. It runs as a separate crawler command (`apps/crawler` CLI, e.g. `pnpm -C apps/crawler discover`) that the standing loop may invoke between crawl runs. It writes only to `companies`; the next crawl run picks up new rows because adapters read active companies from the table. Discovery inserts no `jobs` rows — jobs from a discovered Greenhouse board arrive later with `source = 'greenhouse'`, not `source = 'discovery'`.
* **Failure isolation:** an error in one candidate (network failure, malformed HTML, unexpected board API body) is appended to `stats.errors` and the run continues with the remaining candidates; `runDiscovery` itself only rejects if the search client cannot be constructed at all (e.g. missing `ANTHROPIC_API_KEY`).
* **Contract statements (signatures, not implementations):**

```ts
// packages/core — pure, no I/O
type BoardCandidate =
  | { kind: 'board'; ats: 'greenhouse' | 'lever' | 'ashby'; board_token: string }
  | { kind: 'page'; url: string };
export function extractCandidate(url: string): BoardCandidate;
export function buildDiscoveryQueries(criteria: Criteria): string[]; // length <= 8

// apps/crawler — deps injected so tests can mock search/fetch/db
export interface SearchClient {
  search(query: string): Promise<{ url: string; title: string }[]>; // Anthropic web_search wrapper
}
export interface DiscoveryStats {
  searches: number; inserted: number; skippedKnown: number;
  invalid: number; other: number; errors: string[];
}
export function runDiscovery(deps: {
  searchClient: SearchClient; fetchFn: typeof fetch;
  companies: CompaniesRepo; criteria: Criteria; logger: Logger;
}): Promise<DiscoveryStats>;
```

* **Insert rules:** a validated board candidate becomes a `companies` row with `ats`, `board_token` (lowercased), `name` (from the validation payload when it carries one, else the slug), `discovered_via = 'web-search'`, `active = true`. An unrecognizable careers page becomes `ats = 'other'`, `board_token = null`, `careers_url` set, and `name` derived from the page's `<title>` (trimmed, truncated at 80 chars) or, when the title is empty/missing, the registrable domain of `careers_url` (e.g. `acme.com`). Because `unique (ats, board_token)` does not constrain rows with a null `board_token`, discovery must check for an existing row with the same `careers_url` before inserting an `'other'` row.

## 3. Black-Box Test Cases

Fixture discipline: every fixture named below is a **real captured payload**, not a hand-written guess. **Capturing them is implementation task #1** (run the real search once, hit the real board APIs once, save the responses verbatim).

Fixtures:
* `apps/crawler/test/fixtures/discovery/web-search-greenhouse-react-native.json` — real `web_search` result block for `site:job-boards.greenhouse.io "react native"`
* `apps/crawler/test/fixtures/discovery/web-search-generic.json` — real result block for a generic query, containing at least one non-ATS careers page URL
* `apps/crawler/test/fixtures/greenhouse/board-mattermost.json` — real `boards-api.greenhouse.io/v1/boards/mattermost/jobs` response
* `apps/crawler/test/fixtures/lever/postings-valid-site.json` — real `api.lever.co/v0/postings/{site}?mode=json` response for a live site
* `apps/crawler/test/fixtures/ashby/job-board-valid-org.json` — real `api.ashbyhq.com/posting-api/job-board/{org}` response for a live org
* `apps/crawler/test/fixtures/discovery/careers-page-with-lever-link.html` — real careers page HTML containing an `https://jobs.lever.co/{site}` link
* `apps/crawler/test/fixtures/discovery/careers-page-no-ats.html` — real careers page HTML with no recognizable ATS link
* `apps/crawler/test/fixtures/discovery/robots-disallow.txt` — real robots.txt that disallows the careers path being fetched

### Scenario 1: Board-token extraction from all four URL shapes (happy path, pure function)
* **Given:** the following result URLs:
  * `https://job-boards.greenhouse.io/mattermost/jobs/5238290008`
  * `https://boards.greenhouse.io/acmeco`
  * `https://jobs.lever.co/plaid/9c9e1cf5-0000-0000-0000-000000000000`
  * `https://jobs.ashbyhq.com/linear/frontend-engineer`
* **When:** `extractCandidate(url)` is called on each
* **Then:** it returns, in order: `{ kind: 'board', ats: 'greenhouse', board_token: 'mattermost' }`, `{ kind: 'board', ats: 'greenhouse', board_token: 'acmeco' }`, `{ kind: 'board', ats: 'lever', board_token: 'plaid' }`, `{ kind: 'board', ats: 'ashby', board_token: 'linear' }`. Trailing path segments (job IDs) are dropped; tokens are lowercased. A URL on none of these hosts returns `{ kind: 'page', url }`.

### Scenario 2: Validated new board is inserted (happy path, end to end)
* **Given:** a mocked `SearchClient` returning the URLs from `fixtures/discovery/web-search-greenhouse-react-native.json` (includes `job-boards.greenhouse.io/mattermost/...`); a mocked `fetchFn` serving `fixtures/greenhouse/board-mattermost.json` with status 200 for the greenhouse validation URL; an empty `companies` repo stub
* **When:** `runDiscovery(deps)` completes
* **Then:** exactly one insert call is made for that candidate with `ats = 'greenhouse'`, `board_token = 'mattermost'`, `discovered_via = 'web-search'`, `active = true`, and a non-empty `name`; `stats.inserted >= 1` and `stats.errors` is empty.

### Scenario 3: Already-known (ats, board_token) is not re-inserted (edge case)
* **Given:** the same search results as Scenario 2, but the `companies` repo stub already contains a row with `ats = 'greenhouse'`, `board_token = 'mattermost'`
* **When:** `runDiscovery(deps)` completes
* **Then:** no insert call is made for `('greenhouse', 'mattermost')`; no board-API validation fetch is made for it (known candidates are skipped before validation); `stats.skippedKnown >= 1`; `stats.errors` is empty.

### Scenario 4: Candidate whose board API returns 404 is not inserted (error case)
* **Given:** search results containing `https://boards.greenhouse.io/ghosttown`; a mocked `fetchFn` returning status 404 for `https://boards-api.greenhouse.io/v1/boards/ghosttown/jobs`
* **When:** `runDiscovery(deps)` completes
* **Then:** no insert call is made for that candidate; `stats.invalid >= 1`; the run does not throw — remaining candidates are still processed (assert a later valid candidate in the same run is inserted).

### Scenario 5: Generic careers page linking to a known ATS resolves to that ATS company
* **Given:** search results containing a generic page URL; robots.txt for that host allows the path; a mocked `fetchFn` serving `fixtures/discovery/careers-page-with-lever-link.html` for the page and `fixtures/lever/postings-valid-site.json` (status 200) for the lever validation URL
* **When:** `runDiscovery(deps)` completes
* **Then:** one insert call is made with `ats = 'lever'`, `board_token` equal to the `{site}` slug in the page's `jobs.lever.co/{site}` link, `discovered_via = 'web-search'`, `active = true`. No row with `ats = 'other'` is inserted for that page.

### Scenario 6: Unrecognizable careers page becomes an ats=other row (edge case)
* **Given:** search results containing a generic page URL; robots.txt allows; a mocked `fetchFn` serving `fixtures/discovery/careers-page-no-ats.html` (no greenhouse/lever/ashby links)
* **When:** `runDiscovery(deps)` completes, then runs a second time with a repo stub containing the row from the first run
* **Then:** first run inserts exactly one row with `ats = 'other'`, `board_token = null`, `careers_url` set to the page URL, `discovered_via = 'web-search'`, `active = true`, and a non-empty `name`; `stats.other = 1`. Second run inserts nothing for that URL (matched on `careers_url`). No fetch of any further page on that site occurs (v1 does not scrape arbitrary pages).

### Scenario 7: The 8-search budget is never exceeded
* **Given:** a `criteria` value whose `role_priorities[].keywords` would naively produce more than 8 queries; a mocked `SearchClient` that counts calls and returns `[]`
* **When:** `buildDiscoveryQueries(criteria)` is called and `runDiscovery(deps)` completes
* **Then:** `buildDiscoveryQueries(criteria).length <= 8`; the mock's call count equals the query list length and is `<= 8`; `stats.searches` equals the call count. A second assertion with the default criteria from CONTRACT.md also yields `<= 8`.

### Scenario 8: robots.txt disallow blocks the generic page fetch (error case)
* **Given:** search results containing a generic page URL; a mocked `fetchFn` serving `fixtures/discovery/robots-disallow.txt` for that host's `/robots.txt`, which disallows the page path
* **When:** `runDiscovery(deps)` completes
* **Then:** the page URL itself is never fetched (assert against the mock's recorded calls); no `companies` row is inserted for it; the skip is recorded (either `stats.errors` entry or logger call naming the URL); the run still exits normally.

## 4. Definition of Done

- [ ] All 8 scenarios implemented as automated tests in `apps/crawler/test/discovery.test.ts` (plus pure-function tests may live in `packages/core`); `pnpm vitest run --root apps/crawler test/discovery.test.ts` exits 0.
- [ ] All named fixture files exist and were captured from real payloads (implementation task #1): `ls apps/crawler/test/fixtures/discovery apps/crawler/test/fixtures/greenhouse apps/crawler/test/fixtures/lever apps/crawler/test/fixtures/ashby` lists every file named in §3.
- [ ] No placeholder tests: `grep -rnE '\.(only|skip)\(' apps/crawler/test/discovery.test.ts` produces no output.
- [ ] `pnpm test` exits 0 (no regressions across the workspace).
- [ ] `pnpm typecheck` exits 0.
