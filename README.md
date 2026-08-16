<h1 align="center">JobScout</h1>

<p align="center">
  <strong>A job search engine that only looks for the jobs you'd actually take.</strong>
</p>

<p align="center">
  Crawls ten job sources on a schedule, scores every posting against your criteria,<br>
  ranks how painful the application will be, and pings Discord when something good lands.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-strict-3178c6" alt="TypeScript">
  <img src="https://img.shields.io/badge/pnpm-workspace-f69220" alt="pnpm workspace">
  <img src="https://img.shields.io/badge/Next.js-App%20Router-000000" alt="Next.js">
  <img src="https://img.shields.io/badge/Postgres-Neon-00e599" alt="Postgres">
  <img src="https://img.shields.io/badge/auto--apply-never-3fb950" alt="No auto-apply">
</p>

---

## The problem

Job boards optimize for volume. You get a hundred postings a day, ninety of them
irrelevant, and the ten that matter are buried behind an application form that
wants your entire work history retyped into separate text fields.

JobScout inverts that. It watches a curated set of companies, scores each posting
against what you actually want, and tells you **how expensive the application
will be before you start it**. Nothing is auto-applied. A human decides, always.

## Difficulty ranking

The feature that makes the rest worth having. Every posting is graded:

| Grade | What it means |
| --- | --- |
| **easy** | Standard fields only: name, email, phone, resume, links. No essays, no account, no re-keying your work history. |
| **medium** | Extra questions beyond the standard set, but still a single form. |
| **hard** | Account creation, long-form essays, or a bespoke portal. |

For Greenhouse this is **deterministic, with no LLM involved**: the adapter
fetches the posting with `questions=true` and compares the field names against a
known standard set. Every field in the set means `easy`; anything beyond it means
`medium`. Only the ambiguous cases fall through to a language model, which keeps
the grading cheap, fast, and reproducible.

Sorting by "easy, high score, posted today" is the whole product in one query.

## Where postings come from

**Ten job sources**, crawled every three hours:

- Six ATS APIs — Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Recruitee
- Four search feeds — the monthly HN *Who is hiring?* thread via Algolia,
  RemoteOK, Remotive, and We Work Remotely

**Fifteen curated startup-intel sources**, swept daily, feed the *company* list
rather than the job list: the YC directory, Ramp's vendor reports, Harmonic's Hot
25, several a16z newsletters, the a16z / Sequoia / Index / Founders Fund
portfolio pages, TechCrunch venture news, Product Hunt, and the annual lists
(Forbes AI 50, LinkedIn Top Startups, Enterprise Tech 30).

Each sweep parses only new items, extracts company names, then **resolves each
company to a live board** on any of the six ATSes — a near-exact slug probe
first, falling back to web search. New companies are inserted, and the regular
crawl picks up their postings from there. That resolution step is what turns "a
newsletter mentioned this startup" into "we are now watching their careers page."

## Matching

A keyword prescreen runs first, because sending every posting to a language model
is how you spend a lot of money to learn that a Java role is not a React Native
role. What survives gets LLM-scored against your criteria.

The role priorities are configuration, not code — the shipped default is
mobile-first (react-native / expo / ios / android / swift / kotlin / flutter at
priority 1, react and frontend at 2, fullstack at 3), editable from the web UI.

The LLM is pluggable via `LLM_PROVIDER`: a hosted API or a local LM Studio model.
Local costs nothing per token, which matters when you are grading thousands of
postings.

## The board

A Next.js App Router app over the same Postgres database.

**Public.** Anyone can browse the postings, scores, difficulty grades, sources,
and crawl history. No account, no login.

**Private.** The pipeline layered on top — which postings were queued, applied
to, or dismissed, and the notes attached to each — renders only for the signed-in
owner. Every mutating Server Action calls its own auth guard rather than trusting
the middleware, so opening the read paths did not open the write paths.

That split is enforced by `optionalUser` (returns null instead of redirecting)
versus `requireAllowedUser` (redirects or 403s), and both are covered by tests.

## Layout

```
apps/
  crawler/     the pipeline: adapters, discovery, classifier, notifier, CLI
  admin/       Next.js board (public read, owner-only writes)
packages/
  core/        schemas, enums, queries, dedup, status machine — shared, typed
supabase/
  migrations/  plain SQL, ordered
.agent/specs/  ATDD specs; CONTRACT.md is the canonical behaviour document
```

The crawler is a CLI (`crawl`, `discover`, `sources`, `criteria`, `doctor`,
`loop`) scheduled by launchd locally, so the expensive, long-running, credential-
holding part never runs in a serverless function.

## Tests

```sh
pnpm test     # unit + integration
pnpm e2e      # the whole pipeline, end to end
```

`pnpm e2e` is the one worth looking at. It runs the entire pipeline against a
local fixture HTTP server and an in-process Postgres (PGlite), with **zero
external network traffic** — no ATS, no LLM, no Discord. It is a real end-to-end
proof that runs in CI and on a plane, which is a different and much more useful
thing than a suite of mocks.

`pnpm -C apps/crawler doctor` checks a live environment: env vars, database
reachability, LLM provider, Discord webhook.

## Setup

```sh
pnpm install
cp .env.example .env          # fill in the database URL and LLM provider
psql "$SUPABASE_DB_URL" -f supabase/migrations/0001_init.sql
pnpm -C apps/crawler doctor   # verify the environment
pnpm -C apps/crawler crawl    # one pass
pnpm -C apps/admin dev        # the board on :3000
```

Env vars are documented in [`.env.example`](.env.example) and, for the web app,
[`apps/admin/README.md`](apps/admin/README.md). Nothing is exposed to the
browser: there is no `NEXT_PUBLIC_` database configuration, and a test asserts
that stays true.

## Design notes

- **[SPEC.md](SPEC.md)** — the plan and spec index
- **[.agent/specs/atdd/CONTRACT.md](.agent/specs/atdd/CONTRACT.md)** — the
  canonical behaviour contract, written before the code
- **[apps/crawler/test/e2e/README.md](apps/crawler/test/e2e/README.md)** — how
  the offline end-to-end harness works

## No auto-apply

Deliberate, and not a limitation. Mass-applying is how you get blacklisted by the
ATS vendors everyone uses, and a form filled in by a robot reads like one. This
finds the roles and tells you which are cheap to apply to. You write the
application.

## License

MIT.
