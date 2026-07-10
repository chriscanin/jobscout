# ATDD Specification: Scraped board adapters (CalJobs, Indeed, ZipRecruiter)

## 1. Problem Statement

**Context.** jobscout's crawler pulls jobs from adapters (CONTRACT.md §Source adapter interface). Greenhouse/Lever/Ashby have documented JSON APIs and are covered by another spec. Three sources have no public API: CalJobs (caljobs.ca.gov, a Geographic Solutions portal), Indeed, and ZipRecruiter. For these we do light, polite HTML scraping of public search-results pages, driven by keywords and locations from `criteria.value`, capped at 3 result pages per source per run.

**The risk, stated plainly.** Indeed and ZipRecruiter are heavily anti-bot protected (Cloudflare/PerimeterX-style challenges). These two adapters are **best-effort**. On any run they may get nothing. They must detect blocked responses (HTTP 403/429, CAPTCHA markers, challenge pages), record the error so it lands in `crawl_runs.stats`, return an empty array, and never crash the run. They must never attempt any bypass — no CAPTCHA solving, no header spoofing beyond a normal browser UA, no headless-browser evasion. The documented fallback is v2 logged-in browser automation on the dedicated Mac (out of scope here). CalJobs is a public government portal without deliberate anti-bot hardening, but it is a Geographic Solutions ASP.NET application: search may require form POSTs echoing `__VIEWSTATE`/`__EVENTVALIDATION` state, not just a session cookie. Treat it as real scraping work with the same graceful-degradation path as the other two, not as a guaranteed-reliable source.

**The Gap.** None of the three adapters exists. There is no blocked-response detection, no stable `external_id` derivation for scraped sources, and no fixture corpus.

**Impact.** Without these, jobscout only sees jobs at companies already known to use Greenhouse/Lever/Ashby. CalJobs in particular lists California employers (Chris's `states: ["CA"]` criterion) that never appear on ATS boards.

## 2. System Constraints & Environment

From CONTRACT.md — the contract wins on any conflict:

- TypeScript, Node 22, pnpm workspaces. Adapters live in `apps/crawler/src/adapters/` (`caljobs.ts`, `indeed.ts`, `ziprecruiter.ts`), implementing `SourceAdapter` from `packages/core`. Tests: vitest via `pnpm test`; also `pnpm typecheck`, `pnpm build`.
- `source` enum values used here: `caljobs`, `indeed`, `ziprecruiter`. Upsert dedupe key: unique `(source, external_id)` on `jobs` — so `externalId` derivation must be byte-stable across runs.
- Politeness (contract §Politeness): normal browser UA, ≥ 2s spacing per domain, **≤ 3 search-result pages per scraped source per run** (a per-source total, not per-query). All spacing/retry lives in the `ctx.fetch` helper; adapters must issue every HTTP request through `ctx.fetch` and never through global `fetch`.
- Never bypass CAPTCHAs or logins in v1. If a source blocks us: record the error, skip the source, keep the run going.

Adapter interface (verbatim from the contract):

```ts
interface SourceAdapter {
  source: Source;
  fetchJobs(ctx: CrawlCtx): Promise<RawJob[]>;
}
```

`CrawlCtx` fields these adapters use (per the contract: criteria, active companies, a polite fetch helper, and a logger — no other surface). Adapters report errors as error-level `ctx.logger` calls; the pipeline records those in `crawl_runs.stats[source].errors` (the same surface the API-boards spec uses):

```ts
interface CrawlCtx {
  criteria: CriteriaValue;              // parsed criteria.value
  fetch(url: string, init?: RequestInit): Promise<Response>; // politeness + retry built in
  logger: Logger;                       // logger.error(...) messages end up in crawl_runs.stats[source].errors
}
```

`external_id` derivation (must be stable across runs):

| source        | derivation                                                                 |
|---------------|-----------------------------------------------------------------------------|
| `caljobs`     | the job order number from the result's detail link / listing                |
| `indeed`      | the `jk` query parameter of the job link (tracking params discarded)        |
| `ziprecruiter`| the listing id embedded in the job URL (path/query junk discarded)          |

Blocked detection is a shared helper `isBlockedResponse(status: number, body: string): boolean` in `apps/crawler/src/adapters/blocked.ts`: true when status is 403 or 429, or when the body contains challenge markers (e.g., `captcha`, `hcaptcha`, `cf-chl`, `Just a moment`, `px-captcha` — the final marker list is derived from the captured challenge fixtures, not guessed).

**Fixtures.** All tests run offline: `ctx.fetch` is stubbed to serve fixture files; the vitest setup stubs global `fetch` to throw, so any adapter bypassing `ctx.fetch` fails the suite. **Implementation task #1 is capturing the real payloads below** (evidence discipline: real payloads, not guessed ones). Each fixture has a sibling `<name>.meta.json` recording capture URL, date, and HTTP status.

- `apps/crawler/test/fixtures/caljobs/search-results-page1.html` — real captured search-results page
- `apps/crawler/test/fixtures/caljobs/search-results-page2.html` — real captured page 2
- `apps/crawler/test/fixtures/caljobs/search-results-page3.html` — pagination fixture for C3: the real page1 capture with its job order numbers and pagination block mechanically altered so the markup advertises 5 pages (same mutation mechanism as `layout-changed.html`, mutation recorded in `.meta.json`); if the real page1/page2 captures don't themselves advertise 5 pages, C3 serves equally documented pagination-block mutations of them
- `apps/crawler/test/fixtures/caljobs/session-handshake.json` — captured cookie handshake (request URLs, statuses, `Set-Cookie` headers)
- `apps/crawler/test/fixtures/caljobs/layout-changed.html` — page1 fixture with the selector-bearing class names/ids mechanically renamed (documented mutation of a real capture)
- `apps/crawler/test/fixtures/indeed/search-results-page1.html` — real captured search-results page (capture from a browser session; plain curl will likely be blocked)
- `apps/crawler/test/fixtures/indeed/search-results-page2.html` — pagination fixture for I4: the real page1 capture with its listing `jk` ids and pagination block mechanically altered (capturing 3+ real Indeed pages through anti-bot protection is not required; mutation recorded in `.meta.json`)
- `apps/crawler/test/fixtures/indeed/search-results-page3.html` — same mechanism as page2, with distinct `jk` ids and markup still advertising further pages
- `apps/crawler/test/fixtures/indeed/blocked-403.html` — real captured blocked/challenge body
- `apps/crawler/test/fixtures/ziprecruiter/search-results-page1.html` — real captured search-results page
- `apps/crawler/test/fixtures/ziprecruiter/blocked-429.html` — real captured blocked/challenge body
- `apps/crawler/test/fixtures/ziprecruiter/layout-changed.html` — documented mutation of the real page1 capture

If a 200-status challenge page cannot be captured for Indeed, the test stub may serve the `blocked-403.html` body with status 200 (the body is still a real capture).

## 3. Black-Box Test Cases

All scenarios call `adapter.fetchJobs(ctx)` with a stubbed `ctx`: `criteria` = the contract's default criteria value, `fetch` = a stub that serves fixtures and records every requested URL and header, `logger` = a spy that records every error-level call. Global `fetch` throws if called.

### CalJobs (`apps/crawler/src/adapters/caljobs.ts`)

**C1 — happy path: real fixture parses into RawJobs with stable external_ids**
- **Given** `ctx.fetch` serves `caljobs/search-results-page1.html` for the search-results request
- **When** `fetchJobs(ctx)` resolves
- **Then** it returns ≥ 1 `RawJob`; every job has `source === 'caljobs'`, a non-empty `title` and `company`, an absolute `url` starting with `https://www.caljobs.ca.gov`, and `externalId` equal to that listing's job order number (non-empty, digits only, containing no `?`, `&`, `=`, or `/`)
- **And** calling `fetchJobs(ctx)` a second time against the same fixture returns the identical sorted list of `externalId`s
- **And** `externalId`s within the page are unique.

**C2 — session-cookie flow**
- **Given** `ctx.fetch` replays `caljobs/session-handshake.json`: the initial request returns the captured redirect/`Set-Cookie` response, and the search-results request returns `search-results-page1.html` only when the request carries the session cookie (otherwise it returns the captured logged-out/expired-session response)
- **When** `fetchJobs(ctx)` resolves
- **Then** the recorded requests show the cookie value from `Set-Cookie` echoed in the `Cookie` header of the search-results request, and the returned jobs match C1's `externalId`s.

**C3 — pagination stops at the 3-page cap**
- **Given** `ctx.fetch` serves `caljobs/search-results-page1.html`, `search-results-page2.html`, and the `search-results-page3.html` pagination fixture (§2) — pages 1–3 all parseable, pagination markup advertising 5 pages
- **And** `ctx.criteria` contains all four default `role_priorities` keyword groups
- **When** `fetchJobs(ctx)` resolves
- **Then** exactly 3 search-result page requests were made in total across all keywords/locations (per-source cap, not per-query), no request for page 4 or 5 exists in the recorded URLs, and the returned jobs are the union of pages 1–3.

**C4 — layout changed: parse miss yields empty array plus recorded error, not garbage**
- **Given** `ctx.fetch` serves `caljobs/layout-changed.html` (selectors no longer match)
- **When** `fetchJobs(ctx)` resolves
- **Then** it returns `[]` (never rows with empty `title`, `company`, `url`, or `externalId`)
- **And** the spy logger received exactly one error-level call with a message containing `caljobs` and `parse`
- **And** the promise resolves — it does not reject.

### Indeed (`apps/crawler/src/adapters/indeed.ts`)

**I1 — happy path: external_id from the jk parameter, tracking junk discarded**
- **Given** `ctx.fetch` serves `indeed/search-results-page1.html`
- **When** `fetchJobs(ctx)` resolves
- **Then** it returns ≥ 1 `RawJob`; every job has `source === 'indeed'`, `externalId` equal to the `jk` value of its job link (non-empty, matching `/^[0-9a-f]+$/i`), and `url === 'https://www.indeed.com/viewjob?jk=' + externalId`
- **And** for at least one fixture listing whose link carries extra query params beyond `jk` (the test asserts the fixture contains one), the derived `externalId` equals its `jk` value alone
- **And** a second parse of the same fixture returns the identical sorted `externalId` list.

**I2 — blocked with HTTP 403: empty array, recorded error, no bypass attempt**
- **Given** `ctx.fetch` serves `indeed/blocked-403.html` with status 403 for the first search request
- **When** `fetchJobs(ctx)` resolves
- **Then** it returns `[]`
- **And** the spy logger received exactly one error-level call with a message containing `indeed`, `403`, and `blocked`
- **And** after the blocked response, zero further requests were recorded (no retries beyond `ctx.fetch`'s own policy, no alternate endpoints, no requests to any host other than `*.indeed.com`).

**I3 — challenge page delivered with HTTP 200 is still detected as blocked**
- **Given** `ctx.fetch` serves the captured challenge body with status 200
- **When** `fetchJobs(ctx)` resolves
- **Then** it returns `[]`, the spy logger received exactly one error-level call with a message containing `indeed` and `challenge`, and zero further requests were recorded after detection.

**I4 — pagination stops at the 3-page cap**
- **Given** `ctx.fetch` serves `indeed/search-results-page1.html` plus the page-2/page-3 pagination fixtures (§2), each parseable and advertising more than 3 pages
- **When** `fetchJobs(ctx)` resolves
- **Then** exactly 3 search-result page requests were recorded and no page-4+ URL appears in the recorded requests.

### ZipRecruiter (`apps/crawler/src/adapters/ziprecruiter.ts`)

**Z1 — happy path: external_id from the listing id in the URL**
- **Given** `ctx.fetch` serves `ziprecruiter/search-results-page1.html`
- **When** `fetchJobs(ctx)` resolves
- **Then** it returns ≥ 1 `RawJob`; every job has `source === 'ziprecruiter'`, a non-empty `title` and `company`, an absolute `url` on `ziprecruiter.com`, and `externalId` equal to the listing id extracted from that job's URL (non-empty, unique within the page, containing no `?`, `&`, `=`, or `/`)
- **And** a second parse returns the identical sorted `externalId` list.

**Z2 — blocked with HTTP 429: empty array plus recorded error, run continues**
- **Given** `ctx.fetch` serves `ziprecruiter/blocked-429.html` with status 429
- **When** `fetchJobs(ctx)` resolves
- **Then** it returns `[]`, the promise does not reject, and the spy logger received exactly one error-level call with a message containing `ziprecruiter`, `429`, and `blocked`, and zero further requests were recorded after detection.

**Z3 — layout changed: empty array plus recorded parse error, not garbage rows**
- **Given** `ctx.fetch` serves `ziprecruiter/layout-changed.html` with status 200
- **When** `fetchJobs(ctx)` resolves
- **Then** it returns `[]` (no rows with empty `title`, `company`, `url`, or `externalId`), and the spy logger received exactly one error-level call with a message containing `ziprecruiter` and `parse`.

## 4. Definition of Done

- [ ] Real fixtures captured and committed (implementation task #1): `ls apps/crawler/test/fixtures/caljobs apps/crawler/test/fixtures/indeed apps/crawler/test/fixtures/ziprecruiter` lists every file named in §2, each with a sibling `.meta.json`.
- [ ] All scenarios C1–C4, I1–I4, Z1–Z3 implemented as vitest tests and passing: `pnpm test` exits 0.
- [ ] `pnpm typecheck` exits 0 and `pnpm build` exits 0.
- [ ] No network in tests: the vitest setup stubs global `fetch` to throw, so `pnpm test` passing offline is the proof (verify with Wi-Fi off or `grep -rn "stubGlobal('fetch'" apps/crawler/test/` showing the guard).
- [ ] No bypass tooling: `grep -riE "2captcha|anticaptcha|capsolver|puppeteer-extra|stealth" apps/crawler/package.json` exits 1 (no matches).
