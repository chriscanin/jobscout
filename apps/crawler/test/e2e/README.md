# jobscout end-to-end convergence suite (spec 09)

This directory holds the **win-condition** proof for jobscout: one command,
`pnpm e2e`, that runs the whole crawl pipeline — criteria → seed sync → adapters
→ upsert → missing-streak → classify → expire → notify → `crawl_runs` record —
end to end, deterministically, with **zero external traffic**, and exits 0.

It is a *real* end to end, not a pile of self-asserting mocks:

- a **real** `node:http` fixture server (`fixture-server.ts`) serves the captured
  board / job-detail / lever / apply-page fixtures at the same API paths the real
  hosts use, plus a fixture-backed Anthropic Messages endpoint and a Discord
  webhook sink;
- the **real** pipeline (`runCrawl`) drives the **real** greenhouse + lever
  adapters, the **real** classifier (`scoreMatch` + `rankDifficulty`) and the
  **real** notifier, wired to the server through an injected routing `fetch`
  (the real `createHttpClient`) so no production code path is bypassed;
- an in-process **PGlite** database (the same `supabase/migrations` applied) is
  the one shared DB;
- a no-op advisory lock is injected because PGlite is single-connection (real
  cross-process locking is exercised against real Postgres elsewhere).

Run it:

```bash
export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"
pnpm e2e            # from the repo root (delegates to apps/crawler)
```

## Fixture-server design

`startFixtureServer()` binds an ephemeral port on `127.0.0.1` and returns a
handle. Every request it receives is **recorded** (method, path, query, parsed
JSON body, timestamp) so tests can assert exactly what Discord and Anthropic
received.

| Route | Behavior | Backing fixture |
|---|---|---|
| `GET /v1/boards/:token/jobs` | greenhouse board listing (`mattermost` → captured board; unknown token → empty board) | `fixtures/greenhouse/mattermost-board.json` |
| `GET /v1/boards/:token/jobs/:id` | greenhouse job detail with questions (only `5238290008`, the sole prescreen-passing posting) | `fixtures/greenhouse/mattermost-job-5238290008.json` |
| `GET /v0/postings/:slug` | lever postings JSON | `fixtures/lever/board-postings.json` |
| `GET /greenhouse-apply/*` | greenhouse apply page (difficulty rule-3 input) | inline HTML |
| `GET /lever-apply/*`, `GET *…/apply` | lever apply page (difficulty rule-3 input) | inline HTML |
| `POST /anthropic/v1/messages` | fixture-backed Anthropic Messages: scoring batch (body carries the criteria JSON) → deterministic per-job scores; difficulty fallback (body carries the `"Ulta Beauty"` rubric marker) → `medium` | computed from the request body |
| `GET /discord/webhook` | webhook metadata `{ id, token }` (doctor GET) | — |
| `POST /discord/webhook` | records the body, returns `204` | — |
| `GET /__requests` | the recorded request log as JSON | test-only |
| `POST /__control/board` | `{ "drop": "<id>" }` / `{ "reset": true }` swap which board variant is served | test-only |

**Routing fetch (`makeRoutingFetch`).** The real `createHttpClient` is used with
a `transport` that rewrites the real hosts onto the fixture server:

- `boards-api.greenhouse.io/v1/boards/…` → `<base>/v1/boards/…`
- `job-boards.greenhouse.io/<board>/jobs/<id>` → `<base>/greenhouse-apply/…`
- `api.lever.co/v0/postings/…` → `<base>/v0/postings/…`
- `jobs.lever.co/<slug>/<id>/apply` → `<base>/lever-apply/…`

Any other host is rejected with `FIXTURE_MODE_ESCAPE`, so an accidental real
request fails loudly instead of leaking traffic. Per-host politeness spacing is
waived for the fixture host only.

**Fixture-backed Anthropic (`makeFixtureAnthropic`).** An `AnthropicLike` whose
`messages.create` POSTs the params to `/anthropic/v1/messages`, so every model
call lands in the recorded log and the server computes a deterministic response.
The scorer gives react-native titles score 88, react/frontend titles 82, and
everything else 5 — all **outside** the 40–70 band, so no sonnet re-score ever
fires (as spec 09 requires).

## The five fixture-mode scenarios (`convergence.test.ts`)

They run in order against **one** server + **one** database:

- **S1 — happy path.** One `runCrawl` → exit 0; ≥ 1 `react-native` job with a
  non-null `match_score`, a decided `difficulty`, and ≥ 1 `difficulty_reason`;
  newest `crawl_runs` row `ok=true`, `trigger=manual`, `notified_count ≥ 1`, with
  per-source `greenhouse`/`lever` stats (numeric fetched/new/updated + empty
  errors) and **no** `FIXTURE_MODE_ESCAPE`; the scoring batch and the lever
  difficulty fallback both hit the recorded Anthropic log; the lever LLM job is
  `medium` with reasons.
- **S2 — Discord shape.** ≥ 1 recorded webhook POST; every body has 1–10 embeds;
  the RN reference embed (url contains `5238290008`) carries the color for the
  difficulty the pipeline assigned it (the captured RN posting has 19 questions
  incl. custom fields → greenhouse rule ⇒ `medium` ⇒ `0xF1C40F`); the RN job is
  `notified` with a `notified_at`.
- **S3 — idempotency.** A second unchanged run → exit 0; zero new Discord posts;
  same job count (upsert, no dupes); `min(last_seen_at)` strictly advanced; two
  `ok=true` runs recorded.
- **S4 — expiry vs queued.** Move the lever job to `queued` (a real data-layer
  transition), drop both it and the RN job from the served boards, run two more
  cycles → the RN job (was `notified`) becomes `expired` with
  `missing_streak ≥ 2`; the `queued` job stays `queued` though it is also
  missing (expiry only touches `new`/`notified`).
- **S5 — doctor.** `runDoctor` against the fixture environment → exit 0, all four
  checks (`env`, `supabase`, `discord`, `anthropic`) ok; with
  `DISCORD_WEBHOOK_URL` unset → non-zero exit whose output names
  `DISCORD_WEBHOOK_URL`.

---

## Scenario 6 — admin sees the job and Queue persists (browser-gated, manual)

Not part of `pnpm e2e` (no browser here). Verify in a **real browser** with the
chrome-devtools MCP once real Auth0 + DB credentials exist. A **production build**
of the admin is required — dev/HMR builds emit console info logs that would make
the empty-console assertion unpassable.

Prerequisites:

1. A database in post-S1 state (run the crawl once against a real DB, or point
   the admin at a DB seeded with the fixture RN job `5238290008`).
2. `apps/admin` built and started against that DB with working Auth0 test-tenant
   config and `ADMIN_ALLOWED_EMAILS` containing the tester's email:
   ```bash
   export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"
   pnpm --filter ./apps/admin run build
   pnpm --filter ./apps/admin run start   # serves http://localhost:3000
   ```

Steps (chrome-devtools MCP recipe):

1. `navigate_page` → `http://localhost:3000`.
2. Complete the Auth0 login as the allowlisted email.
3. `navigate_page` → `http://localhost:3000/jobs`.
4. `list_console_messages` then clear it; **refresh twice**
   (`navigate_page` to the same URL, or press-reload, twice).
5. **Assert:** `list_console_messages` returns **zero** messages after both
   refreshes.
6. `take_snapshot` and **assert** a table row whose title link reads
   *"Senior React Native Engineer"* (external id `5238290008`) is present.
7. `click` that row's **Queue** button (the `new|notified → queued` server
   action).
8. **Assert (SQL):**
   ```sql
   SELECT status FROM jobs WHERE source='greenhouse' AND external_id='5238290008';
   -- expect: queued
   ```
9. Refresh once more; **assert** the row now renders status `queued` and the
   console is still empty.

---

## Live-smoke checklist (manual, once, real traffic)

Run once against the real Mattermost Greenhouse board and a **test-channel**
Discord webhook. `JOBSCOUT_FIXTURE_MODE` must be **unset**.

1. Fill `apps/crawler/.env` with real values:
   - `SUPABASE_DB_URL` — a real **session-mode** connection string (direct
     `:5432` or the session pooler) so the advisory lock holds for the run;
   - `ANTHROPIC_API_KEY` — a real key;
   - `DISCORD_WEBHOOK_URL` — a **test-channel** webhook.
2. Confirm `apps/crawler/seeds/companies.seed.json` contains Mattermost
   (`ats='greenhouse'`, `boardToken='mattermost'`).
3. Push migrations to the real DB:
   ```bash
   export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"
   pnpm db:push
   ```
4. `pnpm doctor` → exits 0 (env, supabase, discord GET, anthropic all green).
5. One real crawl:
   ```bash
   pnpm --filter ./apps/crawler run crawl -- --trigger manual
   ```
   → exits 0; the newest `crawl_runs` row has `ok=true` and
   `stats.greenhouse.fetched > 0`.
6. A message with ≤ 10 embeds arrives in the test Discord channel; embed colors
   match the difficulty map (easy green / medium yellow / hard red / unknown grey).
7. Run the same command again → **no** new Discord message; `last_seen_at`
   advanced on the still-listed jobs.
8. Record the date and the smoke run's `crawl_runs.id` at the bottom of
   `.agent/specs/atdd/09-convergence.atdd.md`.

<!-- Live smoke record: date=____ crawl_runs.id=____ -->
