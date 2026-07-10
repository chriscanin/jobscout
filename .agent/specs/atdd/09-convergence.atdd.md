# ATDD Specification: Convergence (end-to-end win condition)

## 1. Problem Statement

**Context.** Specs 01–08 each prove one seam of jobscout: adapters, normalization, classification, difficulty, notification, expiry, admin, doctor. Each passes in isolation with its own fixtures.

**The Gap.** Nothing proves the seams work *together*: criteria load → seed sync → adapters → upsert → missing-streak → classify → expire → notify → `crawl_runs` record, in the fixed pipeline order from CONTRACT.md, against one shared database, in one process exit code.

**Impact.** Without a single repeatable proof, "done" is a judgment call. This spec defines the win condition: one command, `pnpm e2e`, that exercises the whole pipeline deterministically with zero external traffic and exits 0 — plus one manual live-smoke checklist and one browser-gated admin check.

## 2. System Constraints & Environment

From the contract: TypeScript, Node 22, pnpm workspaces (`apps/crawler`, `apps/admin`, `packages/core`, `supabase/migrations`, `ops/`); Supabase Postgres; vitest; crawler env `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `DISCORD_WEBHOOK_URL`; admin env additionally `AUTH0_*` and `ADMIN_ALLOWED_EMAILS`. Table names, enums, status machine, difficulty rubric, notify rule, and pipeline order are exactly as in CONTRACT.md.

### Fixture mode

- `JOBSCOUT_FIXTURE_MODE=1` plus `JOBSCOUT_FIXTURE_BASE_URL=http://127.0.0.1:<port>` (both set by the harness; not in the production env list) reroute every external dependency — board APIs, apply-page fetches, the Anthropic API, the Discord webhook — to a local fixture HTTP server started by the test harness.
- In fixture mode the fetch helper in `packages/core` throws `FIXTURE_MODE_ESCAPE` on any request whose host is not the fixture server's host. Per-domain 2s politeness spacing is waived for the fixture host only.
- The e2e harness registers **only the `greenhouse` and `lever` adapters** with the cycle runner (the adapter list is injected into the runner — the same mechanism 07 uses for stub adapters). The scraped sources (`caljobs`, `indeed`, `ziprecruiter`) and discovery have no fixture routes and do not run under `pnpm e2e`; they would otherwise hit real hosts, throw `FIXTURE_MODE_ESCAPE`, and (per 07's adapter isolation) be recorded as per-source errors without failing the run.
- Database: the e2e harness uses the Supabase CLI local stack (`supabase start`), resets it with `supabase db reset` (applies `supabase/migrations`), and points `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` at it. Production stays on hosted Supabase.

### Fixture server (brief)

A plain Node HTTP server owned by the test harness. It serves captured fixtures from `apps/crawler/test/fixtures/` and records every request it receives (method, path, query, JSON body, timestamp) so tests can assert on them.

| Route | Behavior | Fixture file |
|---|---|---|
| `GET /greenhouse/v1/boards/mattermost/jobs` | board listing | `apps/crawler/test/fixtures/greenhouse/mattermost-board.json` |
| `GET /greenhouse/v1/boards/mattermost/jobs/:id?questions=true` | job detail with questions | `apps/crawler/test/fixtures/greenhouse/mattermost-job-<id>.json` (one per retained posting; includes `mattermost-job-5238290008.json`, the easy reference) |
| `GET /lever/v0/postings/:slug?mode=json` | Lever postings | `apps/crawler/test/fixtures/lever/board-postings.json` |
| `GET /lever-pages/:slug/:id/apply` | apply-page HTML (difficulty rule 3 input) | `apps/crawler/test/fixtures/lever/apply-page.html` |
| `POST /anthropic/v1/messages` (scoring batch: body contains the serialized criteria JSON, per 05's `scoreMatch` prompt) | canned haiku scoring response for the captured board's jobs | `apps/crawler/test/fixtures/anthropic/messages-score-batch.json` |
| `POST /anthropic/v1/messages` (difficulty fallback: body contains the rubric marker `"Ulta Beauty"`, per 05's rubric prompt) | canned haiku difficulty response | `apps/crawler/test/fixtures/anthropic/messages-difficulty-medium.json` |
| `POST /discord/webhook` | responds `204`, records body | (none — response is empty) |
| `GET /__requests` | returns the recorded request log as JSON | test-only |
| `POST /__control/board` | swaps which board fixture is served (`{"source":"greenhouse","variant":"minus-two"}` → `apps/crawler/test/fixtures/greenhouse/mattermost-board-minus-two.json`) | test-only |

**Evidence discipline — implementation task #1** is capturing the real payloads: the live Mattermost Greenhouse board (`https://job-boards.greenhouse.io/mattermost`, API `boards.greenhouse.io`), its per-job `questions=true` details, a real Lever company's postings JSON and apply-page HTML (a company whose board lists at least one react/frontend role), and two real Anthropic Messages API responses captured with a real key: one haiku scoring-batch response for the captured board's jobs (captured so every score falls outside the 40–70 sonnet re-score band — no sonnet call occurs in fixture mode) and one haiku difficulty-fallback response. No payloads are hand-written. The board capture may be trimmed to ≤ 10 postings by deletion-only edits; `mattermost-board-minus-two.json` is derived from the capture by deleting exactly two entries. Capture-time choices are pinned in `apps/crawler/test/fixtures/manifest.json`:

```json
{
  "greenhouse": { "boardToken": "mattermost", "rnJobExternalId": "…", "expireJobExternalId": "5238290008", "queuedJobExternalId": "…" },
  "lever": { "slug": "…", "llmJobExternalId": "…" }
}
```

The capture must include at least one Greenhouse posting whose title matches a priority-1 keyword from the default criteria (`react native`, `mobile engineer`, …); if the live Mattermost board lacks one at capture time, capture a second real Greenhouse board that has one and record it in the manifest.

### Contract statements introduced here

- Crawl CLI invocation: `pnpm --filter ./apps/crawler run crawl -- --trigger manual` (writes `crawl_runs.trigger = 'manual'`).
- Discord embed color per `difficulty`: the single map in `packages/core` is **owned by the notifier spec (06 §Embed shape)**; this spec asserts against 06's values verbatim — `easy = 0x2ECC71` (3066993), `medium = 0xF1C40F` (15844367), `hard = 0xE74C3C` (15158332), `unknown = 0x95A5A6` (9807270). If 06 changes, 06 wins.
- `pnpm e2e` at the repo root runs scenarios 1–5 below as one vitest suite (`apps/crawler/test/e2e/convergence.e2e.test.ts`) in order against one fixture server + one reset database, and exits 0 only if all pass.

## 3. Black-Box Test Cases

All SQL runs against the local Supabase stack via psql or the service-role client. `<manifest.X>` means the value pinned in `manifest.json`.

### Scenario 1 — Fresh database, seeded companies, one crawl (happy path)

- **Given** `supabase db reset` has run, the fixture server is up, fixture-mode env is set, and the seed companies file contains Mattermost (`ats='greenhouse'`, `board_token='mattermost'`) and the Lever company from the manifest
- **When** the harness runs `pnpm --filter ./apps/crawler run crawl -- --trigger manual`
- **Then** the process exits 0
- **And** `SELECT count(*) FROM jobs WHERE role_category = 'react-native' AND match_score IS NOT NULL AND difficulty <> 'unknown' AND coalesce(array_length(difficulty_reasons, 1), 0) >= 1;` returns ≥ 1
- **And** the newest `crawl_runs` row has `ok = true`, `trigger = 'manual'`, `notified_count >= 1`, and `stats` contains keys `greenhouse` and `lever`, each with numeric `fetched`, `new`, `updated` and an empty `errors` array
- **And** `GET /__requests` shows ≥ 1 `POST /anthropic/v1/messages` whose body contains the difficulty rubric marker (the Lever job with `external_id = <manifest.lever.llmJobExternalId>` fell through difficulty rules 1–2 to rule 3) and ≥ 1 whose body contains the serialized criteria JSON (the scoring batch ran) and `SELECT difficulty FROM jobs WHERE source='lever' AND external_id='<manifest.lever.llmJobExternalId>';` returns `medium` with a non-empty `difficulty_reasons`

### Scenario 2 — Discord received the notification, correctly shaped

- **Given** scenario 1 has completed
- **When** the test reads `GET /__requests`
- **Then** at least 1 `POST /discord/webhook` was recorded
- **And** every recorded webhook body has an `embeds` array with `1 <= embeds.length <= 10`
- **And** the embed whose `url` field contains external id `5238290008` (the easy reference job, `<manifest.greenhouse.expireJobExternalId>`) has `color === 3066993` (0x2ECC71, easy — 06's palette)
- **And** `SELECT status, notified_at FROM jobs WHERE source='greenhouse' AND external_id='5238290008';` returns `status='notified'` with `notified_at IS NOT NULL`

### Scenario 3 — Second identical run is idempotent (edge case)

- **Given** scenario 2 has completed; the harness records `N_webhooks` = count of recorded `POST /discord/webhook`, `N_jobs` = `SELECT count(*) FROM jobs;`, and `T` = `SELECT max(last_seen_at) FROM jobs;`
- **When** the harness runs the same crawl CLI command again
- **Then** it exits 0, the count of recorded `POST /discord/webhook` still equals `N_webhooks` (zero new Discord messages)
- **And** `SELECT count(*) FROM jobs;` still equals `N_jobs` (upsert on `(source, external_id)`, no duplicates)
- **And** `SELECT min(last_seen_at) FROM jobs;` is strictly greater than `T` (every still-listed job advanced)
- **And** `SELECT count(*) FROM crawl_runs WHERE ok = true;` returns 2

### Scenario 4 — Removed jobs expire; queued jobs survive (edge case)

- **Given** scenario 3 has completed; the harness sets the job `<manifest.greenhouse.queuedJobExternalId>` to `queued` through the `packages/core` data layer (a legal `notified → queued` / `new → queued` transition); then posts `POST /__control/board {"source":"greenhouse","variant":"minus-two"}` so the board fixture no longer lists `5238290008` nor `<manifest.greenhouse.queuedJobExternalId>`
- **When** the harness runs the crawl CLI twice more (both exit 0)
- **Then** `SELECT status, missing_streak FROM jobs WHERE source='greenhouse' AND external_id='5238290008';` returns `status='expired'`, `missing_streak >= 2`
- **And** `SELECT status, missing_streak FROM jobs WHERE source='greenhouse' AND external_id='<manifest.greenhouse.queuedJobExternalId>';` returns `status='queued'`, `missing_streak >= 2` (expiry applies only to `new | notified`)

### Scenario 5 — Doctor passes; doctor fails loudly (happy + error case)

- **5a Given** the fixture environment from scenario 1, **when** the harness runs `pnpm doctor`, **then** it exits 0 and stdout contains one pass line per check — exactly the four checks defined in 07 §Doctor checks: **env** (all env vars present), **supabase** (service-role query succeeds, migrations current), **discord** (webhook reachable), **anthropic** (API reachable)
- **5b Given** the same environment with `DISCORD_WEBHOOK_URL` unset, **when** the harness runs `pnpm doctor`, **then** it exits with a non-zero code and its output contains the string `DISCORD_WEBHOOK_URL` (error case: broken environments are named, not silently tolerated)

Scenarios 1–5 are the fixture-mode win condition: `pnpm e2e` runs them in order and exits 0.

### Scenario 6 — Admin sees the job and Queue persists (browser-gated, not in `pnpm e2e`)

Per the visual-gate rule this is verified in a real browser via chrome-devtools MCP — not curl.

- **Given** the database is in post-scenario-1 state; a **production build** of the admin is running (`pnpm --filter ./apps/admin run build` then `run start`) with the local Supabase env, working Auth0 test-tenant config, and `ADMIN_ALLOWED_EMAILS` containing the tester's email — dev mode is not used because React/Next dev builds unconditionally emit console info logs (React DevTools banner, HMR), which would make the empty-console assertion below unpassable
- **When** the tester executes: `navigate_page` to `http://localhost:3000`, completes Auth0 login as the allowlisted email, navigates to `/jobs`, clears the console, refreshes twice
- **Then** `list_console_messages` returns zero messages (console must be empty after both refreshes)
- **And** the page snapshot contains a row whose title matches the job with `external_id = <manifest.greenhouse.rnJobExternalId>`
- **When** the tester clicks that row's **Queue** action
- **Then** `SELECT status FROM jobs WHERE source='greenhouse' AND external_id='<manifest.greenhouse.rnJobExternalId>';` returns `queued`, and after one more refresh the row renders with status `queued` and the console is still empty

### Live smoke checklist (manual, once, real traffic)

1. Real hosted Supabase project migrated; crawler `.env` filled with real `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, and a **test-channel** `DISCORD_WEBHOOK_URL`. `JOBSCOUT_FIXTURE_MODE` unset.
2. Seed companies file contains Mattermost (`greenhouse`, `board_token='mattermost'`).
3. `pnpm doctor` exits 0.
4. `pnpm --filter ./apps/crawler run crawl -- --trigger manual` exits 0; newest `crawl_runs` row has `ok=true` and `stats.greenhouse.fetched > 0`.
5. A message with ≤ 10 embeds arrived in the test Discord channel; embed colors match the difficulty map.
6. Run the same command again: no new Discord message; `last_seen_at` advanced.
7. Record the date and the `crawl_runs.id` of the smoke run at the bottom of this file.

## 4. Definition of Done

- [ ] `pnpm e2e` exits 0 — scenarios 1–5 pass against the fixture server and a reset local Supabase, with zero external traffic: the suite asserts the recorded request log (`GET /__requests`) contains only fixture-host requests and that no `crawl_runs.stats` errors array contains `FIXTURE_MODE_ESCAPE` (only the greenhouse and lever adapters are registered, per §2)
- [ ] Every fixture named in §2 exists and is non-empty: `for f in greenhouse/mattermost-board.json greenhouse/mattermost-job-5238290008.json greenhouse/mattermost-board-minus-two.json lever/board-postings.json lever/apply-page.html anthropic/messages-score-batch.json anthropic/messages-difficulty-medium.json manifest.json; do test -s "apps/crawler/test/fixtures/$f" || exit 1; done`
- [ ] `pnpm typecheck && pnpm build && pnpm test` all exit 0
- [ ] `pnpm doctor` exits 0 in the fixture environment, and exits non-zero naming `DISCORD_WEBHOOK_URL` when that variable is unset
- [ ] Scenario 6 completed as browser-gated steps (chrome-devtools MCP: navigate, login, clear console, refresh twice, empty console, row visible, Queue clicked) with the closing SQL check returning `queued`
- [ ] Live smoke checklist executed once against the real Mattermost board and a real test Discord webhook; date + `crawl_runs.id` recorded below

<!-- Live smoke record: date=____ crawl_runs.id=____ -->
