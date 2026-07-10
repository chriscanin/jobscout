# ATDD Specification: Discord notifier

## 1. Problem Statement

**Context.** jobscout crawls job sources and stores matches in Supabase. Chris does not
watch the admin app all day; the point of the system is that good new matches come to him.
The delivery channel is a Discord incoming webhook (`DISCORD_WEBHOOK_URL`), one channel,
no bot.

**The gap.** After the classify step, eligible jobs sit in the `jobs` table with
`status = 'new'` and nothing tells Chris they exist. There is no component that selects
the notify-eligible set, formats it as Discord embeds, posts it, and records that it was
posted.

**Impact.** Without the notifier the pipeline is a silent database. With a sloppy notifier
the failure modes are worse than silence: double-posting the same job after a partial
failure, spamming duplicates that differ only by source, or dropping jobs when Discord
rate-limits. This spec pins down selection, message shape, batching, and the exact
failure/recovery behavior.

## 2. System Constraints & Environment

From `CONTRACT.md` (canonical; this spec follows it):

- TypeScript, Node 22, pnpm workspaces. The notifier lives in `apps/crawler` and runs as
  the `notify` step of the crawl pipeline (after expire, before the `crawl_runs` row is
  recorded). Tests are vitest.
- All state is in Supabase Postgres via the data layer in `packages/core`, which enforces
  the status machine (`new → notified` is the only transition the notifier makes; invalid
  transitions throw).
- Env: `DISCORD_WEBHOOK_URL` from `apps/crawler/.env`. No other external service.
- Criteria come from the single `criteria` row (`criteria.value`), default
  `notify_min_score = 60`; priorities from `role_priorities`
  (react-native = 1, react = 2, frontend = 2, fullstack = 3). Categories not listed in
  `role_priorities` (e.g. `other`, or null `role_category`) are treated as priority > 2,
  so they are eligible only when `difficulty = 'easy'`.

**Selection (contract notify rule, as SQL semantics):**

```sql
-- priority(x) resolves from criteria.value.role_priorities; unlisted → treated as > 2
select * from jobs j
where j.status = 'new'
  and j.match_score >= {notify_min_score}
  and (priority(j.role_category) <= 2 or j.difficulty = 'easy')
  and not exists (
    select 1 from jobs prior
    where prior.dedup_hash = j.dedup_hash
      and prior.id <> j.id
      and prior.notified_at is not null   -- "already-notified", even if since queued/applied
  )
order by j.match_score desc, j.first_seen_at asc, j.id asc;
```

**In-run dedup:** after ordering, keep only the first job per `dedup_hash`; later jobs
with the same hash are dropped from the eligible set and stay `new` with `notified_at`
null (on the next run the `not exists` clause excludes them, since their twin is now
notified). `eligibleCount` counts jobs after this dedup.

**Delivery rules:**

- One Discord embed per job. Max 10 embeds per webhook message. Cap 30 jobs per run;
  when capped, the final message's `content` is the plain-text line `+N more in the admin`
  where N = eligible count − 30. The order above decides which 30 go out.
- POST `{ embeds: [...] }` (plus `content` only on a capped final message) to
  `DISCORD_WEBHOOK_URL` as JSON. Any 2xx (Discord returns 204 by default) is success.
- **Per-message commit:** after a message gets a 2xx, each job in that message is
  transitioned `new → notified` through the `packages/core` data layer, which sets
  `notified_at`. Jobs in not-yet-sent messages stay `new`. A partial failure therefore
  never re-posts already-delivered jobs.
- **429:** honor the `retry_after` value from the 429 response once (sleep, retry the same
  message once). If the retry also fails, stop the notify step; remaining jobs stay `new`
  and go out next run. Any other non-2xx: no retry, stop the same way.
- When nothing is eligible: send nothing — zero HTTP requests.

**Interface (contract statement, not implementation):**

```ts
// apps/crawler/src/notify.ts
export interface NotifyResult { notifiedCount: number; eligibleCount: number }

export function notifyNewMatches(deps: {
  data: JobsData;                          // packages/core data layer
  criteria: CriteriaValue;                 // loaded criteria.value
  webhookUrl: string;                      // DISCORD_WEBHOOK_URL
  fetchImpl?: typeof fetch;                // injected mock in tests
  sleep?: (ms: number) => Promise<void>;   // injected fake in 429 tests
}): Promise<NotifyResult>;                 // notifiedCount → crawl_runs.notified_count
```

**Embed shape:** `title` = `{title} at {company}`, `url` = job `url`, `color` by
difficulty — easy `0x2ECC71` (3066993), medium `0xF1C40F` (15844367), hard `0xE74C3C`
(15158332), unknown `0x95A5A6` (9807270). Fields in order: `match_score`,
`role_category`, `location` (omitted when null), `salary_raw` (omitted when null),
`difficulty` (value `"{difficulty} — {first difficulty_reasons entry}"`, or just
`"{difficulty}"` when reasons are null/empty), `apply` (markdown link to `apply_url`,
omitted when null).

**Fixtures (evidence discipline).** Implementation task #1 is capturing one real successful
Discord webhook response with a throwaway webhook, saved as
`apps/crawler/test/fixtures/discord/webhook-response.json` (status, headers, body). The 429
fixture is synthesized from Discord's documented rate-limit shape (`{"message": "You are
being rate limited.", "retry_after": 1.3, "global": false}` with status 429) and saved as
`apps/crawler/test/fixtures/discord/webhook-response-429.json` — the only field the code
reads is `retry_after`, and deliberately hammering Discord to manufacture a real one is
not warranted for a single-user tool. Tests replay both through a mocked `fetchImpl`; no
test hits Discord.

## 3. Black-Box Test Cases

All scenarios: tests seed `jobs` and `criteria` through the data layer, run
`notifyNewMatches` with a mocked `fetchImpl` that records every request and replies from
the captured fixtures, then assert on the recorded requests and the resulting rows.
Default criteria unless stated. Test file: `apps/crawler/test/notify.test.ts`.

### S1 — Happy path: eligible jobs are posted and marked notified
- **Given** two `new` jobs, distinct `dedup_hash`, `match_score` 85 and 70,
  `role_category = 'react-native'`, and a mock webhook replying with the captured 2xx fixture
- **When** `notifyNewMatches` runs
- **Then** exactly one POST is made to the webhook URL with `embeds.length === 2`,
  embeds ordered 85-job first; both rows now have `status = 'notified'` and a non-null
  `notified_at`; the result is `{ notifiedCount: 2, eligibleCount: 2 }`.

### S2 — Eligibility filtering matches the contract rule exactly
- **Given** these `new` jobs (distinct `dedup_hash` except D/E):
  - A: score 55, `react-native`, easy — below threshold
  - B: score 80, `fullstack` (priority 3), medium
  - C: score 80, `fullstack` (priority 3), easy
  - D: score 90, `react` (priority 2), hard, `dedup_hash` equal to existing job E which has
    `notified_at` set (E's current status is `queued`)
  - F: score 70, `frontend` (priority 2), unknown
- **When** `notifyNewMatches` runs
- **Then** the single message contains embeds for exactly C and F; A, B, and D still have
  `status = 'new'` and `notified_at is null`.

### S3 — Embed shape: exact JSON snapshot
- **Given** one `new` job: title `Senior React Native Engineer`, company `Mattermost`,
  `url = 'https://job-boards.greenhouse.io/mattermost/jobs/5238290008'`,
  `apply_url = 'https://job-boards.greenhouse.io/mattermost/jobs/5238290008#app'`,
  `location = 'Remote, US'`, `salary_raw = '$150,000 - $180,000'`, `match_score = 85`,
  `role_category = 'react-native'`, `difficulty = 'easy'`,
  `difficulty_reasons = ['standard Greenhouse fields only']`
- **When** `notifyNewMatches` runs
- **Then** the posted body's single embed deep-equals:

```json
{
  "title": "Senior React Native Engineer at Mattermost",
  "url": "https://job-boards.greenhouse.io/mattermost/jobs/5238290008",
  "color": 3066993,
  "fields": [
    { "name": "match_score", "value": "85", "inline": true },
    { "name": "role_category", "value": "react-native", "inline": true },
    { "name": "location", "value": "Remote, US", "inline": true },
    { "name": "salary_raw", "value": "$150,000 - $180,000", "inline": true },
    { "name": "difficulty", "value": "easy — standard Greenhouse fields only", "inline": true },
    { "name": "apply", "value": "[apply](https://job-boards.greenhouse.io/mattermost/jobs/5238290008#app)", "inline": true }
  ]
}
```

- **And** a second job with null `location`, `salary_raw`, `apply_url`, and null
  `difficulty_reasons` (difficulty `unknown`) yields an embed with `color = 9807270`,
  exactly three fields (`match_score`, `role_category`, `difficulty`), and difficulty
  value `"unknown"`.

### S4 — Batching: 23 eligible jobs → 3 messages of 10/10/3
- **Given** 23 eligible jobs (all priority 1, easy, score ≥ 60, distinct `dedup_hash`),
  mock replies 2xx to everything
- **When** `notifyNewMatches` runs
- **Then** exactly 3 POSTs are made with embed counts `[10, 10, 3]`, no message has a
  `content` line, all 23 rows end `notified`, result `notifiedCount === 23`.

### S5 — Cap at 30 with overflow line (edge case)
- **Given** 35 eligible jobs: 30 with score 90, 5 with score 61
- **When** `notifyNewMatches` runs
- **Then** 3 POSTs with embed counts `[10, 10, 10]`; only the third message has
  `content === "+5 more in the admin"`; the 30 score-90 jobs are `notified`; the 5
  score-61 jobs remain `new`; result `{ notifiedCount: 30, eligibleCount: 35 }`.

### S6 — Partial failure: message 2 of 3 fails (error case)
- **Given** 23 eligible jobs; mock replies 2xx to POST #1 and HTTP 500 to POST #2
- **When** `notifyNewMatches` runs
- **Then** exactly 2 POSTs were made (no message 3); the 10 jobs from message 1 are
  `notified` with `notified_at` set; the other 13 remain `new`; result
  `notifiedCount === 10`.
- **And when** it runs again with the mock now replying 2xx
- **Then** exactly 2 POSTs with embed counts `[10, 3]` containing only the 13 leftover
  jobs — none of the first 10 is re-posted.

### S7 — 429: honor retry_after once (error case)
- **Given** 5 eligible jobs; mock replies to POST #1 with the captured 429 fixture
  (body contains `retry_after`), and an injected fake `sleep` recording its calls
- **When** the retry gets a 2xx: exactly 2 POSTs total, `sleep` was called once with the
  fixture's `retry_after` (converted to ms), all 5 jobs end `notified`.
- **When** instead the retry gets 429 again: exactly 2 POSTs total (no third attempt),
  all 5 jobs remain `new` with `notified_at is null`, result `notifiedCount === 0`.

### S8 — Nothing to send → zero HTTP calls
- **Given** a jobs table where nothing is eligible (only rows below threshold or already
  `notified`)
- **When** `notifyNewMatches` runs
- **Then** the mock fetch was called zero times and the result is
  `{ notifiedCount: 0, eligibleCount: 0 }`.
- **And given** the state produced by a fully successful S1 run, with no DB changes
- **When** `notifyNewMatches` runs a second time
- **Then** zero POSTs are made and every `notified_at` value is unchanged.

### S9 — Same-run dedup collision: only one of two twins is posted
- **Given** two `new` eligible jobs sharing the same `dedup_hash` (same role at the same
  company from two different sources), scores 80 and 75, neither notified before
- **When** `notifyNewMatches` runs
- **Then** the single message contains exactly one embed — the score-80 job — which ends
  `notified`; the score-75 twin still has `status = 'new'` and `notified_at is null`;
  result `{ notifiedCount: 1, eligibleCount: 1 }`.

## 4. Definition of Done

- [ ] Fixtures captured from a real Discord webhook exist:
      `test -f apps/crawler/test/fixtures/discord/webhook-response.json && test -f apps/crawler/test/fixtures/discord/webhook-response-429.json`
- [ ] All notifier scenarios pass: `pnpm vitest run apps/crawler/test/notify.test.ts`
      exits 0 covering S1–S9
- [ ] No focused or skipped tests:
      `! grep -nE '\.(only|skip)\(' apps/crawler/test/notify.test.ts`
- [ ] `pnpm typecheck` exits 0
- [ ] Full suite still green: `pnpm test` exits 0
