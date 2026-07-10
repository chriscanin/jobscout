# jobscout

Personal AI job search engine. A standing crawl loop finds React Native / React / frontend jobs, ranks each by how hard the application is (easy / medium / hard), stacks them in a database, pings Discord when new matches land, and gives you an Auth0-gated admin site to work the queue. **It never auto-applies** — it queues jobs up; you fill them out.

## Source requirements (from Chris, 2026-07-09)

- Roles, in priority order: React Native / mobile app developer first; React developer and frontend developer second; fullstack/backend-leaning only when the application is easy enough to be worth it.
- Difficulty ranking, in Chris's words:
  - **Easy** — boards like [this Mattermost Greenhouse posting](https://job-boards.greenhouse.io/mattermost/jobs/5238290008): no personal questions, no personal info beyond the basics.
  - **Medium** — the same style of board, but with personal questions to answer.
  - **Hard** — portals like Ulta Beauty's: log into their system, make an account, enter work information manually.
- Sources: LinkedIn, CalJobs, Indeed, ZipRecruiter, Toptal, Upwork, plus a general web crawler. V1 covers the API-friendly and lightly-scrapable ones; LinkedIn/Upwork/Toptal are v2 (see below).
- Notifications via Discord. Admin interface hosted online behind Auth0. Personal use only.
- Runs on this Mac first; moves to a dedicated always-on Mac when stable (all state lives in Supabase, so the machine is disposable).

## Where everything is

- `.agent/specs/atdd/CONTRACT.md` — **the canonical contract**: stack, database schema, enums, status machine, difficulty rubric, matching criteria, adapter interface, pipeline order, politeness rules, portability runbook. Every spec conforms to it; on conflict, the contract wins.
- `.agent/specs/atdd/01–09-*.atdd.md` — one ATDD spec per seam. Each has Given/When/Then scenarios and a mechanically-checkable Definition of Done.

## Implementation order (waves)

| Wave | Specs | Notes |
|---|---|---|
| 1 | `01-database` | Migrations + `packages/core` data layer. Everything else depends on it. |
| 2 | `02-adapters-api-boards`, `03-adapters-scraped-boards`, `04-discovery`, `05-classifier`, `06-notifier` | Independent of each other — parallelizable. Each starts by capturing real fixtures. |
| 3 | `07-crawl-loop` | Integrates wave 2 into the CLI + launchd schedule. |
| 4 | `08-admin` | Only depends on wave 1; can start any time after it. |
| 5 | `09-convergence` | The end-to-end win condition: `pnpm e2e` exits 0. |

## Runtime & migration plan

- **Now:** develop and run on the main Mac. `pnpm crawl` for one cycle, `pnpm loop` for a foreground standing loop, launchd (`ops/`) for the every-3-hours schedule.
- **Later:** move to the dedicated Mac: clone repo → copy `.env` → `pnpm install` → `pnpm doctor` green → `ops/install-launchd.sh`. Unload launchd on the old Mac. Nothing else to migrate — jobs, criteria, and run history all live in Supabase.

## External accounts needed before implementation

1. **Supabase** project (free tier) → `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
2. **Discord** → a webhook on the channel you want pings in → `DISCORD_WEBHOOK_URL`
3. **Auth0** → a Regular Web Application for the admin → `AUTH0_*` vars, plus `ADMIN_ALLOWED_EMAILS`
4. **Anthropic API key** for classification/discovery → `ANTHROPIC_API_KEY`
5. **Vercel** project for `apps/admin`

## V2 (explicitly out of scope for these specs)

- **LinkedIn, Upwork, Toptal** — login-walled and heavily anti-bot. Plan: logged-in browser automation (computer use) on the dedicated Mac at low frequency, using your own sessions. Speced separately when v1 is stable.
- **Interactive Discord bot** (Queue/Dismiss/Applied buttons on the message) — the webhook is v1; a bot can replace it later without touching the pipeline.
- Indeed/ZipRecruiter adapters are best-effort in v1; if they stay blocked, they graduate to the same v2 browser-automation lane.
