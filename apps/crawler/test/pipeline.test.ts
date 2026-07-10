/**
 * Pipeline tests — spec 07 Scenarios 1–4.
 *
 * Discipline: NO network. Every cycle runs in-process on PGlite (migrations
 * applied, criteria row seeded) with:
 *   - stub adapters injected via `opts.adapters` (in-memory SourceAdapters),
 *   - a mock LLM client so classification is deterministic (all stub jobs
 *     score >= 60, role_category priority <= 2 → notify-eligible, difficulty easy),
 *   - a mock Discord fetch (records POST bodies; no real webhook),
 *   - an injected `acquireLock` so the single-flight branch is deterministic
 *     (PGlite has one connection and cannot model two contending sessions).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPgliteTestDb,
  type Db,
  type Logger,
  type RawJob,
  type SourceAdapter,
} from "@jobscout/core";
import { runCrawl, CRAWL_LOCK_KEY, type CrawlLock } from "../src/pipeline.js";
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
// Test doubles
// ---------------------------------------------------------------------------

/** A silent logger (captures nothing; keeps test output clean). */
function silentLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

/** A logger that captures every message for "already running" assertions. */
function capturingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const push =
    (level: string) =>
    (m: string, ...a: unknown[]) =>
      lines.push(`${level} ${m} ${a.map((x) => String(x)).join(" ")}`.trim());
  return {
    lines,
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
  };
}

/**
 * A stub SourceAdapter that returns a fixed list of RawJobs (or throws). Ignores
 * ctx.companies — the pipeline still builds a real CrawlCtx and passes it in.
 */
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

/** Build a notify-eligible RawJob (React Native title → priority-1 keyword). */
let _seq = 0;
function rawJob(source: RawJob["source"], overrides: Partial<RawJob> = {}): RawJob {
  const seq = ++_seq;
  return {
    source,
    externalId: `${source}-${seq}`,
    url: `https://example.com/${source}/${seq}`,
    // Non-hard-ATS host so difficulty falls to the (mocked) LLM step.
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
 * Mock LLM client: answers BOTH classifier calls deterministically.
 *  - scoring (prompt asks for a JSON array): score 85, role_category react-native.
 *  - difficulty (prompt asks for a JSON object): easy.
 * Records every request for assertions.
 */
function mockLlm(): LlmClient & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    calls,
    label: "mock:llm",
    async complete(req: LlmRequest): Promise<string> {
      calls.push(req);
      const prompt = req.user;
      if (prompt.includes("JSON array")) {
        // scoreMatch batch: echo each job id with a passing score.
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
          })),
        );
      }
      // difficulty fallback: JSON object.
      return JSON.stringify({
        difficulty: "easy",
        difficulty_reasons: ["apply in place, standard fields"],
      });
    },
  };
}

/** A mock Discord fetch that records POST bodies and returns 204. */
function mockDiscord(): {
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
      count++;
      if (init?.body) posts.push(JSON.parse(init.body as string));
      return new Response("", { status: 200 });
    },
  };
}

/**
 * A fetch (HttpClient-shaped) that returns apply-page HTML instantly — no real
 * network, no politeness delay. Used for the classifier's difficulty fallback
 * so cycles run fast and offline.
 */
function instantFetch(): (url: string, init?: RequestInit) => Promise<Response> {
  return async () => new Response("<html><body>Apply here</body></html>", { status: 200 });
}

/** An acquireLock that always grants a no-op lock (the normal test path). */
function grantLock(): (db: Db) => Promise<CrawlLock | null> {
  return async () => ({ release: async () => {} });
}

async function countRows(table: string): Promise<number> {
  const r = await db.query(`select count(*)::int as n from ${table}`);
  return r.rows[0].n as number;
}

// ---------------------------------------------------------------------------
// Scenario 1 — Full cycle records a correct crawl_runs row (happy path)
// ---------------------------------------------------------------------------

describe("Scenario 1 — full cycle happy path", () => {
  it("records one crawl_runs row with correct per-source stats + notified_count", async () => {
    const adapters = [
      stubAdapter("greenhouse", [rawJob("greenhouse"), rawJob("greenhouse")]),
      stubAdapter("lever", [rawJob("lever")]),
    ];
    const discord = mockDiscord();

    const summary = await runCrawl(db, {
      trigger: "manual",
      adapters,
      acquireLock: grantLock(),
      llm: mockLlm(),
      fetch: instantFetch(),
      webhookUrl: "https://discord.test/webhook",
      notifyFetch: discord.fetchImpl,
      logger: silentLogger(),
    });

    expect(summary.exitCode).toBe(0);
    expect(summary.ok).toBe(true);
    expect(summary.skipped).toBe(false);

    // Exactly one crawl_runs row, trigger manual, ok true, timestamps set.
    expect(await countRows("crawl_runs")).toBe(1);
    const run = await db.query(`select * from crawl_runs`);
    const row = run.rows[0];
    expect(row.trigger).toBe("manual");
    expect(row.ok).toBe(true);
    expect(row.started_at).not.toBeNull();
    expect(row.finished_at).not.toBeNull();

    // Per-source stats.
    const stats = row.stats as Record<
      string,
      { fetched: number; new: number; updated: number; errors: string[] }
    >;
    expect(stats.greenhouse).toEqual({ fetched: 2, new: 2, updated: 0, errors: [] });
    expect(stats.lever).toEqual({ fetched: 1, new: 1, updated: 0, errors: [] });

    // notified_count = 3 and all 3 jobs are notified.
    expect(row.notified_count).toBe(3);
    expect(summary.notifiedCount).toBe(3);
    const jobs = await db.query(`select status, notified_at from jobs`);
    expect(jobs.rows).toHaveLength(3);
    for (const j of jobs.rows) {
      expect(j.status).toBe("notified");
      expect(j.notified_at).not.toBeNull();
    }

    // Exactly one Discord POST with 3 embeds (one per job, <= 10 per message).
    expect(discord.callCount()).toBe(1);
    expect(discord.posts).toHaveLength(1);
    expect((discord.posts[0] as { embeds: unknown[] }).embeds).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — One adapter throwing does not kill the run (error case)
// ---------------------------------------------------------------------------

describe("Scenario 2 — one adapter throws, run continues", () => {
  it("records the error, processes other sources, and completes ok", async () => {
    const adapters = [
      stubAdapter("greenhouse", () => {
        throw new Error("boom 502");
      }),
      stubAdapter("lever", [rawJob("lever")]),
    ];
    const discord = mockDiscord();

    const summary = await runCrawl(db, {
      trigger: "manual",
      adapters,
      acquireLock: grantLock(),
      llm: mockLlm(),
      fetch: instantFetch(),
      webhookUrl: "https://discord.test/webhook",
      notifyFetch: discord.fetchImpl,
      logger: silentLogger(),
    });

    expect(summary.exitCode).toBe(0);
    const run = await db.query(`select * from crawl_runs`);
    const row = run.rows[0];
    expect(row.ok).toBe(true);

    const stats = row.stats as Record<
      string,
      { fetched: number; new: number; updated: number; errors: string[] }
    >;
    // greenhouse threw: fetched 0, error captured.
    expect(stats.greenhouse.fetched).toBe(0);
    expect(stats.greenhouse.errors.some((e) => e.includes("boom 502"))).toBe(true);
    // lever still processed.
    expect(stats.lever.new).toBe(1);
    expect(row.notified_count).toBe(1);

    const jobs = await db.query(`select status from jobs`);
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0].status).toBe("notified");
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — Concurrent second invocation is a no-op (edge case)
// ---------------------------------------------------------------------------

describe("Scenario 3 — lock already held → no-op", () => {
  it("exits 0, logs 'already running', and writes nothing", async () => {
    // Seed a prior job so we can assert the counts don't change.
    await db.query(
      `insert into jobs (source, external_id, url, title, company, dedup_hash)
       values ('greenhouse','pre-1','https://x/1','T','C','h1')`,
    );
    const jobsBefore = await countRows("jobs");
    const runsBefore = await countRows("crawl_runs");

    const discord = mockDiscord();
    const llm = mockLlm();
    const logger = capturingLogger();

    const summary = await runCrawl(db, {
      trigger: "manual",
      adapters: [stubAdapter("greenhouse", [rawJob("greenhouse")])],
      // Lock NOT acquired (another session holds it).
      acquireLock: async () => null,
      llm,
      webhookUrl: "https://discord.test/webhook",
      notifyFetch: discord.fetchImpl,
      logger,
    });

    expect(summary.exitCode).toBe(0);
    expect(summary.skipped).toBe(true);
    expect(summary.run).toBeNull();
    expect(logger.lines.join("\n")).toContain("already running");

    // Zero writes: row counts unchanged.
    expect(await countRows("jobs")).toBe(jobsBefore);
    expect(await countRows("crawl_runs")).toBe(runsBefore);

    // Zero HTTP: no Discord POST, no LLM call.
    expect(discord.callCount()).toBe(0);
    expect(llm.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — A crashed run cannot wedge the lock
// ---------------------------------------------------------------------------

describe("Scenario 4 — crashed run releases the lock", () => {
  it("a later cycle acquires the lock, completes, and writes ok = true", async () => {
    // Simulate: the previous holder crashed (its session dropped, releasing the
    // session-scoped advisory lock). The next acquireLock therefore succeeds.
    let acquisitions = 0;
    const acquireLock = async (): Promise<CrawlLock | null> => {
      acquisitions++;
      return { release: async () => {} };
    };

    const discord = mockDiscord();
    const summary = await runCrawl(db, {
      trigger: "manual",
      adapters: [stubAdapter("greenhouse", [rawJob("greenhouse")])],
      acquireLock,
      llm: mockLlm(),
      fetch: instantFetch(),
      webhookUrl: "https://discord.test/webhook",
      notifyFetch: discord.fetchImpl,
      logger: silentLogger(),
    });

    expect(acquisitions).toBe(1);
    expect(summary.ok).toBe(true);
    expect(summary.skipped).toBe(false);
    const run = await db.query(`select ok from crawl_runs`);
    expect(run.rows).toHaveLength(1);
    expect(run.rows[0].ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lock key constant is fixed (spec 07 §Single-flight contract).
// ---------------------------------------------------------------------------

describe("CRAWL_LOCK_KEY", () => {
  it("is the fixed bigint 8123407", () => {
    expect(CRAWL_LOCK_KEY).toBe(8123407);
  });
});
