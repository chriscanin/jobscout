/**
 * Adversarial pipeline tests — the easy-to-break semantics of the crawl loop
 * that the happy-path scenarios do NOT prove on their own (spec 07 §2 fixed
 * order; CONTRACT §Crawl pipeline). NO network — everything runs in-process on
 * PGlite with injected stubs.
 *
 * These lock down four things a refactor could silently break:
 *   1. ORDER: classify runs BEFORE notify (a job must be scored before it can be
 *      eligible), and expire runs BEFORE notify (a job that expires this cycle
 *      must not also be notified this cycle).
 *   2. ISOLATION: a throwing adapter is caught, its error lands in THAT source's
 *      stats.errors, and every OTHER source still runs and upserts — the loop
 *      does not short-circuit.
 *   3. MISSING-STREAK / EXPIRE across cycles: a job that disappears for two
 *      cycles becomes expired; a queued job that disappears does not.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPgliteTestDb,
  type Db,
  type Logger,
  type RawJob,
  type SourceAdapter,
} from "@jobscout/core";
import { runCrawl, type CrawlLock, type RunCrawlOptions } from "../src/pipeline.js";
import type { LlmClient, LlmRequest } from "../src/llm.js";

let db: Db;
let closeDb: () => Promise<void>;

beforeEach(async () => {
  ({ db, close: closeDb } = await createPgliteTestDb());
});

afterEach(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// Shared test doubles
// ---------------------------------------------------------------------------

function silentLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function stubAdapter(
  source: SourceAdapter["source"],
  jobs: RawJob[] | (() => never),
): SourceAdapter {
  return {
    source,
    async fetchJobs() {
      if (typeof jobs === "function") return jobs();
      return jobs;
    },
  };
}

let _seq = 0;
function rawJob(source: RawJob["source"], overrides: Partial<RawJob> = {}): RawJob {
  const seq = ++_seq;
  return {
    source,
    externalId: `${source}-${seq}`,
    url: `https://example.com/${source}/${seq}`,
    applyUrl: `https://example.com/${source}/${seq}/apply`,
    title: "React Native Engineer",
    company: `Company ${seq}`,
    location: "Remote, US",
    description: "Build mobile apps with react native and expo.",
    raw: {},
    ...overrides,
  };
}

/**
 * Mock LLM that scores every batch job 85 (react-native) and answers difficulty
 * `easy`. Optionally records a marker into a shared timeline when it is first
 * invoked, so ordering relative to the notifier can be asserted.
 */
function mockLlm(onCall?: () => void): LlmClient & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    calls,
    label: "mock:llm",
    async complete(req: LlmRequest): Promise<string> {
      onCall?.();
      calls.push(req);
      const prompt = req.user;
      if (prompt.includes("JSON array")) {
        const jobsJson = prompt.match(/JOBS \(JSON\):\n(\[[\s\S]*?\])\n/);
        const ids: string[] = jobsJson
          ? (JSON.parse(jobsJson[1]) as Array<{ id: string }>).map((j) => j.id)
          : [];
        return JSON.stringify(
          ids.map((id) => ({
            id,
            role_category: "react-native",
            match_score: 85,
            match_reasons: ["react native match"],
            remote_us_ok: true,
          })),
        );
      }
      return JSON.stringify({
        difficulty: "easy",
        difficulty_reasons: ["apply in place, standard fields"],
      });
    },
  };
}

/** A mock Discord fetch that records POST bodies and returns 200. */
function mockDiscord(onPost?: () => void): {
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  posts: unknown[];
  callCount: () => number;
} {
  const posts: unknown[] = [];
  let count = 0;
  return {
    posts,
    callCount: () => count,
    fetchImpl: async (_input, init) => {
      onPost?.();
      count++;
      if (init?.body) posts.push(JSON.parse(init.body as string));
      return new Response("", { status: 200 });
    },
  };
}

function instantFetch(): (url: string, init?: RequestInit) => Promise<Response> {
  return async () => new Response("<html><body>Apply here</body></html>", { status: 200 });
}

function grantLock(): (db: Db) => Promise<CrawlLock | null> {
  return async () => ({ release: async () => {} });
}

/** Common injected deps for a fully offline cycle. */
function baseOpts(over: Partial<RunCrawlOptions> = {}): RunCrawlOptions {
  return {
    trigger: "manual",
    acquireLock: grantLock(),
    llm: mockLlm(),
    fetch: instantFetch(),
    webhookUrl: "https://discord.test/webhook",
    notifyFetch: mockDiscord().fetchImpl,
    logger: silentLogger(),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. ORDER — classify runs BEFORE notify
// ---------------------------------------------------------------------------

describe("pipeline order — classify precedes notify", () => {
  it("scores each job before the notifier posts (timeline: classify before notify)", async () => {
    const timeline: string[] = [];
    const llm = mockLlm(() => timeline.push("classify"));
    const discord = mockDiscord(() => timeline.push("notify"));

    const summary = await runCrawl(
      db,
      baseOpts({
        adapters: [stubAdapter("greenhouse", [rawJob("greenhouse")])],
        llm,
        notifyFetch: discord.fetchImpl,
      }),
    );

    expect(summary.ok).toBe(true);
    // The job was notified, which is only possible if it was scored >= 60 first.
    expect(summary.notifiedCount).toBe(1);
    // The first classify call strictly precedes the first notify POST.
    const firstClassify = timeline.indexOf("classify");
    const firstNotify = timeline.indexOf("notify");
    expect(firstClassify).toBeGreaterThanOrEqual(0);
    expect(firstNotify).toBeGreaterThanOrEqual(0);
    expect(firstClassify).toBeLessThan(firstNotify);

    // Cross-check via persisted state: the job carries the classifier's score
    // AND is notified — proving classify wrote before notify read/marked.
    const j = await db.query(
      `select status, match_score, notified_at from jobs where source = 'greenhouse'`,
    );
    expect(j.rows[0].match_score).toBe(85);
    expect(j.rows[0].status).toBe("notified");
    expect(j.rows[0].notified_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. ORDER — expire runs BEFORE notify
// ---------------------------------------------------------------------------

describe("pipeline order — expire precedes notify", () => {
  it("a stale-but-notify-eligible job expires this cycle and is NOT notified", async () => {
    // Seed a job that is otherwise notify-eligible (status new, match_score 90,
    // priority-1 category) BUT has missing_streak = 2, so it is due to expire.
    // Its external_id is NOT returned by any adapter this cycle, so the streak
    // stays >= 2 through the increment step and expire flips it to `expired`
    // BEFORE the notifier's eligibility query runs. If notify ran before expire,
    // this job would be posted; it must not be.
    await db.query(
      `insert into jobs
         (source, external_id, url, title, company, dedup_hash,
          status, match_score, role_category, difficulty, missing_streak)
       values
         ('greenhouse','stale-1','https://x/stale','Stale RN Role','StaleCo','h-stale',
          'new', 90, 'react-native', 'easy', 2)`,
    );

    const discord = mockDiscord();
    // A fresh job from the adapter IS eligible and should be notified — so a
    // notify POST happens; we assert the stale job is absent from it.
    const summary = await runCrawl(
      db,
      baseOpts({
        adapters: [stubAdapter("greenhouse", [rawJob("greenhouse")])],
        notifyFetch: discord.fetchImpl,
      }),
    );

    expect(summary.ok).toBe(true);

    // The stale job was expired (expire ran) and never notified.
    const stale = await db.query(
      `select status, notified_at from jobs where external_id = 'stale-1'`,
    );
    expect(stale.rows[0].status).toBe("expired");
    expect(stale.rows[0].notified_at).toBeNull();

    // Exactly the one fresh adapter job was notified (the stale one excluded).
    expect(summary.notifiedCount).toBe(1);
    const embeds = (discord.posts[0] as { embeds: { title?: string }[] }).embeds;
    const titles = JSON.stringify(embeds);
    expect(titles).not.toContain("Stale RN Role");
  });
});

// ---------------------------------------------------------------------------
// 3. ISOLATION — a throwing adapter does not short-circuit the others
// ---------------------------------------------------------------------------

describe("adapter isolation — a throw is contained to its source", () => {
  it("caught error lands in that source's stats, EVERY other source still upserts", async () => {
    // Order matters: put the throwing adapter BETWEEN two healthy ones to prove
    // the loop continues past a throw (not just that a later source ran).
    const adapters = [
      stubAdapter("greenhouse", [rawJob("greenhouse")]),
      stubAdapter("lever", () => {
        throw new Error("boom 502 lever down");
      }),
      stubAdapter("ashby", [rawJob("ashby")]),
    ];
    const discord = mockDiscord();

    const summary = await runCrawl(
      db,
      baseOpts({ adapters, notifyFetch: discord.fetchImpl }),
    );

    expect(summary.exitCode).toBe(0);
    expect(summary.ok).toBe(true);

    const run = await db.query(`select * from crawl_runs`);
    const stats = run.rows[0].stats as Record<
      string,
      { fetched: number; new: number; updated: number; errors: string[] }
    >;

    // The throw is contained to lever.
    expect(stats.lever.fetched).toBe(0);
    expect(stats.lever.new).toBe(0);
    expect(stats.lever.errors.some((e) => e.includes("boom 502 lever down"))).toBe(true);

    // Both OTHER sources ran and upserted, with clean error lists.
    expect(stats.greenhouse).toEqual({ fetched: 1, new: 1, updated: 0, errors: [] });
    expect(stats.ashby).toEqual({ fetched: 1, new: 1, updated: 0, errors: [] });

    // The two healthy jobs are persisted; the lever job is not.
    const jobs = await db.query(`select source from jobs order by source`);
    expect(jobs.rows.map((r) => r.source)).toEqual(["ashby", "greenhouse"]);

    // Both healthy jobs classified + notified (throw did not stop the pipeline).
    expect(summary.notifiedCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 4. MISSING-STREAK / EXPIRE integrate across cycles
// ---------------------------------------------------------------------------

describe("missing-streak + expire across cycles", () => {
  it("a job gone for two cycles expires; a queued job that disappears does not", async () => {
    // Cycle 1: greenhouse lists ONE job (gh-keep). Also seed a `queued` job
    // (as if the admin queued it) that the source will NOT list — it must never
    // expire regardless of missing_streak.
    const keep = rawJob("greenhouse", { externalId: "gh-keep" });

    await runCrawl(
      db,
      baseOpts({ adapters: [stubAdapter("greenhouse", [keep])] }),
    );

    // Seed a queued job the adapter never lists (queued jobs are terminal for
    // the crawler's expiry — status not in (new, notified)).
    await db.query(
      `insert into jobs
         (source, external_id, url, title, company, dedup_hash, status, missing_streak)
       values
         ('greenhouse','gh-queued','https://x/q','Queued Role','QCo','h-q','queued', 0)`,
    );

    // Confirm the kept job exists, is `new`/`notified`, missing_streak 0.
    let kept = await db.query(
      `select status, missing_streak from jobs where external_id = 'gh-keep'`,
    );
    expect(Number(kept.rows[0].missing_streak)).toBe(0);

    // Cycle 2: greenhouse lists NOTHING → gh-keep missing_streak 0 -> 1,
    // gh-queued 0 -> 1 (still < 2, no expiry yet).
    await runCrawl(
      db,
      baseOpts({ adapters: [stubAdapter("greenhouse", [])] }),
    );

    kept = await db.query(
      `select status, missing_streak from jobs where external_id = 'gh-keep'`,
    );
    expect(Number(kept.rows[0].missing_streak)).toBe(1);
    expect(kept.rows[0].status).not.toBe("expired");

    // Cycle 3: greenhouse still lists nothing → gh-keep 1 -> 2 and expires;
    // gh-queued 1 -> 2 but is `queued` so it must NOT expire.
    await runCrawl(
      db,
      baseOpts({ adapters: [stubAdapter("greenhouse", [])] }),
    );

    kept = await db.query(
      `select status, missing_streak from jobs where external_id = 'gh-keep'`,
    );
    expect(Number(kept.rows[0].missing_streak)).toBe(2);
    expect(kept.rows[0].status).toBe("expired");

    const queued = await db.query(
      `select status, missing_streak from jobs where external_id = 'gh-queued'`,
    );
    expect(Number(queued.rows[0].missing_streak)).toBe(2);
    expect(queued.rows[0].status).toBe("queued");

    // Sanity: three cycles recorded.
    const runs = await db.query(`select count(*)::int as n from crawl_runs`);
    expect(runs.rows[0].n).toBe(3);
  });
});
