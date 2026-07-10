# ATDD Specification: Crawl loop, CLI, scheduling, and portability

Conforms to `/Users/chris/Workspace/jobscout/.agent/specs/atdd/CONTRACT.md`. If anything here conflicts with the contract, the contract wins.

## 1. Problem Statement

**Context.** jobscout's other specs cover the pieces: adapters fetch jobs, the data layer upserts them, the classifier scores them, the notifier posts to Discord. Nothing yet ties those pieces into a runnable program. Chris needs one command that executes a full crawl cycle, a scheduler that runs it every 3 hours unattended on a Mac, and a health check that tells him whether a machine is ready to run it.

**The Gap.** Without an orchestrator there is no `pnpm crawl` entry point, no guarantee the pipeline runs in the contract's fixed order, no protection against two crawls running at once (launchd firing while a manual run is in progress would double-post to Discord), no `crawl_runs` audit trail, and no mechanical way to move the crawler from the dev Mac to the dedicated Mac.

**Impact.** This seam is what makes jobscout an appliance instead of a pile of library code: install launchd once, and matching jobs show up in Discord every 3 hours. A failed adapter must not kill the whole run (one flaky source would silently stop all notifications), and setup on a new Mac must reduce to the contract's five-step runbook.

## 2. System Constraints & Environment

- TypeScript, Node 22, pnpm workspaces. This seam lives in `apps/crawler` (CLI + standing loop) and `ops/` (launchd plist + install/uninstall scripts). Shared types and the data layer come from `packages/core`.
- Supabase Postgres (hosted), accessed with the service-role key. All state lives in Supabase; the crawler machine is disposable.
- Env vars (from `apps/crawler/.env`): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `DISCORD_WEBHOOK_URL`.
- Scheduling: macOS launchd LaunchAgent, `StartInterval` 10800 (3 hours). Logs to `~/Library/Logs/jobscout/`.
- Tests: vitest. Commands: `pnpm test`, `pnpm typecheck`, `pnpm build`. Scenarios that touch the database run against a local Postgres with `supabase/migrations` applied; the advisory-lock scenarios require a real Postgres session (advisory locks cannot be faked). Discord and Anthropic HTTP is stubbed at the fetch layer using captured fixtures.
- Pipeline order (fixed, from the contract): load criteria → sync seed companies into `companies` → run adapters (each isolated) → normalize + upsert → increment `missing_streak` for jobs a source no longer lists → classify → expire (`missing_streak >= 2`, status new/notified) → notify → record `crawl_runs` row.

### Commands defined by this spec

- `pnpm crawl [-- --trigger <launchd|manual|loop>]` — one full cycle. Default trigger `manual`. The launchd plist passes `--trigger launchd`.
- `pnpm doctor` — machine readiness check; exit 0 all green, exit 1 otherwise, naming every failing check.
- `pnpm loop -- --interval <minutes>` — foreground development loop: run a cycle (trigger `loop`), sleep `<minutes>`, repeat until Ctrl-C.

### Single-flight contract

`apps/crawler` exports a constant `CRAWL_LOCK_KEY = 8123407` (arbitrary fixed bigint, never changed). A cycle begins with `SELECT pg_try_advisory_lock(8123407)` on its own session. If it returns false, the process logs a line containing `already running` and exits 0 with zero side effects (no `crawl_runs` row, no job writes, no HTTP calls). On completion the lock is released with `pg_advisory_unlock`; because advisory locks are session-scoped, a crashed or killed run releases the lock automatically when its connection drops — a crash cannot wedge the system.

### `crawl_runs` semantics

`stats` is per-source `{ fetched, new, updated, errors: string[] }`. An adapter that throws is caught: its error message is appended to `stats.<source>.errors` and the run continues with the other sources. `ok = true` means the pipeline ran to completion (per-source errors do not make it false); `ok = false` is written only when the cycle itself aborts partway (the top-level catch still records the row).

### Doctor checks (all four always run; every failure is named)

1. **env** — each of the four env vars is set and non-empty.
2. **supabase** — a service-role query succeeds, and every migration file in `supabase/migrations/` appears in the applied-migrations table (migrations current).
3. **discord** — `GET $DISCORD_WEBHOOK_URL` returns 200 with JSON containing `id` and `token` (Discord returns webhook metadata on GET). No message is posted; doctor never issues a POST.
4. **anthropic** — cheapest possible call: one `messages` request, model `claude-haiku-4-5`, `max_tokens: 1`, succeeds.

### Portability runbook (restating the contract)

Moving the loop from the dev Mac to the dedicated Mac, or rebuilding after a machine dies:

1. New Mac: clone the repo, copy `apps/crawler/.env` over.
2. `pnpm install`
3. `pnpm doctor` — proceed only when green.
4. `ops/install-launchd.sh` — substitutes the absolute repo path and `$HOME` into `ops/com.jobscout.crawl.plist`, creates `~/Library/Logs/jobscout/`, copies the plist to `~/Library/LaunchAgents/`, and `launchctl load`s it.
5. Old Mac: `launchctl unload ~/Library/LaunchAgents/com.jobscout.crawl.plist` (wrapped by `ops/uninstall-launchd.sh`, which also removes the plist copy).

Nothing else to migrate — all state is in Supabase, logs are disposable.

## 3. Black-Box Test Cases

Fixture files referenced below live under `apps/crawler/test/fixtures/<source>/`. **Implementation task #1 is capturing each fixture from the real service** (a real `GET` on a real Discord webhook, a real 1-token Anthropic response, a real webhook POST response) — no guessed payloads.

- `apps/crawler/test/fixtures/discord/webhook-get.json` — webhook metadata returned by GET
- `apps/crawler/test/fixtures/discord/webhook-post.json` — response to a notification POST
- `apps/crawler/test/fixtures/anthropic/messages-ping.json` — minimal `max_tokens: 1` messages response

Stub adapters below are in-memory objects implementing the contract's `SourceAdapter` interface, injected into the cycle runner; classification HTTP is stubbed so scores are deterministic (all stub jobs score ≥ 60, `role_category` priority ≤ 2, distinct `dedup_hash`). Because HTTP is stubbed at the fetch layer (in-process, under vitest), scenarios that assert on those stubs invoke the exported cycle/doctor entry functions in-process and assert on the exit code they resolve with; the `pnpm crawl` / `pnpm doctor` bins are thin wrappers that call the same exports and `process.exit` with the returned code.

### Scenario 1 — Full cycle records a correct `crawl_runs` row (happy path)

- **Given** an empty database with migrations applied, a `greenhouse` stub adapter returning 2 `RawJob`s and a `lever` stub adapter returning 1, and Discord/Anthropic HTTP stubbed with the fixtures above
- **When** one cycle runs with trigger `manual`
- **Then** exactly one `crawl_runs` row exists with `trigger = 'manual'`, `ok = true`, non-null `started_at` and `finished_at`
- **And** `stats.greenhouse` equals `{ "fetched": 2, "new": 2, "updated": 0, "errors": [] }` and `stats.lever` equals `{ "fetched": 1, "new": 1, "updated": 0, "errors": [] }`
- **And** `notified_count = 3`, all 3 `jobs` rows have `status = 'notified'` and non-null `notified_at`, and the Discord stub recorded exactly 1 POST whose body has `embeds.length === 3` (per spec 06's batching rules: one embed per job, up to 10 embeds per webhook message)

### Scenario 2 — One adapter throwing does not kill the run (error case)

- **Given** the same setup but the `greenhouse` stub throws `new Error("boom 502")` and `lever` returns 1 job
- **When** one cycle runs
- **Then** the process exits 0 and the `crawl_runs` row has `ok = true`
- **And** `stats.greenhouse.errors` contains a string containing `boom 502`, with `stats.greenhouse.fetched = 0`
- **And** the lever job was upserted, classified, and notified (`stats.lever.new = 1`, `notified_count = 1`)

### Scenario 3 — Concurrent second invocation is a no-op (edge case)

- **Given** a separate Postgres session that has already called `pg_try_advisory_lock(8123407)` and holds the lock
- **When** the exported cycle entry function (the one the `pnpm crawl` bin wraps) is invoked in-process
- **Then** it resolves with exitCode 0, its logged output contains `already running`, and the counts of `crawl_runs` and `jobs` rows are unchanged
- **And** the HTTP stubs recorded zero requests (no Discord post, no Anthropic call)

### Scenario 4 — A crashed run cannot wedge the lock

- **Given** the lock-holding session from Scenario 3 disconnects without calling `pg_advisory_unlock` (simulating a crashed run)
- **When** a new cycle runs with stub adapters
- **Then** it acquires the lock, completes, and writes a `crawl_runs` row with `ok = true`

### Scenario 5 — Doctor names a missing env var and exits 1 (error case)

- **Given** an environment where `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `ANTHROPIC_API_KEY` are set but `DISCORD_WEBHOOK_URL` is unset
- **When** the exported doctor entry function (the one the `pnpm doctor` bin wraps) runs in-process
- **Then** it resolves with exitCode 1 and its output contains the string `DISCORD_WEBHOOK_URL`
- **And** the output reports a result line for each of the four checks (env, supabase, discord, anthropic) — failures do not short-circuit the remaining checks
- **And** the Discord HTTP stub recorded zero requests

### Scenario 6 — Doctor green path checks without posting

- **Given** all four env vars set, migrations current, and HTTP stubbed: `GET` on the webhook URL returns `discord/webhook-get.json`, Anthropic returns `anthropic/messages-ping.json`
- **When** the exported doctor entry function runs in-process
- **Then** it resolves with exitCode 0
- **And** the Discord stub recorded exactly one request, with method `GET` and zero POSTs
- **And** the Anthropic stub recorded exactly one request with body `model = "claude-haiku-4-5"` and `max_tokens = 1`

### Scenario 7 — launchd plist is valid and correctly configured

- **Given** the repo checkout
- **When** `plutil -lint ops/com.jobscout.crawl.plist` runs
- **Then** it exits 0
- **And** `plutil -extract Label raw ops/com.jobscout.crawl.plist` prints `com.jobscout.crawl`
- **And** `plutil -extract StartInterval raw ops/com.jobscout.crawl.plist` prints `10800`
- **And** the plist's `StandardOutPath` and `StandardErrorPath` values both contain `Library/Logs/jobscout/`, and its `ProgramArguments` array contains `--trigger` followed by `launchd`
- **And** `bash -n ops/install-launchd.sh` and `bash -n ops/uninstall-launchd.sh` both exit 0

### Scenario 8 — Loop mode runs repeated cycles on the interval (edge case, fake timers)

- **Given** vitest fake timers and the loop entry point invoked with `--interval 1` and an injected cycle runner spy (so no real crawl executes)
- **When** the loop starts and the clock is advanced by 61 seconds
- **Then** the cycle runner was invoked exactly twice (once immediately at start, once after the 1-minute sleep), each time with trigger `loop`
- **And** advancing the clock another 60 seconds yields exactly one more invocation (no drift, no overlap — the sleep starts after the cycle finishes)

## 4. Definition of Done

- [ ] `pnpm test` passes, including `apps/crawler` tests implementing Scenarios 1–8 above
- [ ] `pnpm typecheck` and `pnpm build` both exit 0
- [ ] `plutil -lint ops/com.jobscout.crawl.plist` exits 0 and `plutil -extract StartInterval raw ops/com.jobscout.crawl.plist` prints `10800`
- [ ] `bash -n ops/install-launchd.sh && bash -n ops/uninstall-launchd.sh` exits 0
- [ ] Captured fixtures exist and are non-empty: `test -s apps/crawler/test/fixtures/discord/webhook-get.json && test -s apps/crawler/test/fixtures/discord/webhook-post.json && test -s apps/crawler/test/fixtures/anthropic/messages-ping.json`
