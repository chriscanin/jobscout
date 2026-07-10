/**
 * Classifier tests (spec 05 §3, scenarios S1–S8).
 *
 * Discipline: NO network. Every test injects a mocked Anthropic client and a
 * mocked `fetchHtml`. The deterministic paths assert ZERO client/fetch calls.
 * Fixtures are real captures where the source is a public unauthenticated API
 * (Greenhouse), and honestly-marked representative responses where the source
 * needs a key we do not have (Anthropic). Node 22 global `Response` is used to
 * build fake HTTP responses; here we only need the mocks below.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CRITERIA,
  applyMigrations,
  createPgliteTestDb,
  recordCrawlRun,
  upsertJob,
  type Criteria,
  type Db,
  type Job,
  type RawJob,
} from "@jobscout/core";
import {
  classifyPendingJobs,
  prescreen,
  rankDifficulty,
  scoreMatch,
  type ClassifierDeps,
} from "../src/classifier.js";
import type { MessageCreateParams, MessageResponse } from "../src/anthropic.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "fixtures");

async function loadFixture(rel: string): Promise<MessageResponse> {
  const raw = await readFile(path.join(FIX, rel), "utf8");
  return JSON.parse(raw) as MessageResponse;
}

async function loadText(rel: string): Promise<string> {
  return readFile(path.join(FIX, rel), "utf8");
}

/** A capturing mock Anthropic client that returns queued responses in order. */
type MockAnthropic = ClassifierDeps["anthropic"] & {
  calls: MessageCreateParams[];
};

/**
 * Build a mock Anthropic client. `handler(params, callIndex)` returns the
 * response (or throws / rejects) for each call; `calls` records every request.
 */
function mockAnthropic(
  handler: (
    params: MessageCreateParams,
    callIndex: number,
  ) => Promise<MessageResponse> | MessageResponse,
): MockAnthropic {
  const calls: MessageCreateParams[] = [];
  return {
    calls,
    messages: {
      async create(params: MessageCreateParams): Promise<MessageResponse> {
        const idx = calls.length;
        calls.push(params);
        return handler(params, idx);
      },
    },
  };
}

/** A rejected Anthropic call shaped like a 529 overloaded_error. */
function overloadedError(): Error {
  const err = new Error("overloaded_error: the API is temporarily overloaded");
  (err as Error & { status?: number }).status = 529;
  (err as Error & { type?: string }).type = "overloaded_error";
  return err;
}

/** Remap fixture placeholder ids (job-01…) onto real job ids by position. */
function remapScores(
  res: MessageResponse,
  realIds: string[],
): MessageResponse {
  const text = res.content.map((b) => b.text ?? "").join("");
  const arr = JSON.parse(text) as Array<{ id: string }>;
  arr.forEach((row, i) => {
    if (i < realIds.length) row.id = realIds[i];
  });
  return {
    ...res,
    content: [{ type: "text", text: JSON.stringify(arr) }],
  };
}

/** Build a minimal in-memory Job row (defaults: unclassified, new). */
function makeJob(overrides: Partial<Job>): Job {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    source: "greenhouse",
    external_id: overrides.external_id ?? crypto.randomUUID(),
    company_id: null,
    url: "https://example.com/job",
    apply_url: null,
    title: "Engineer",
    company: "Acme",
    location: null,
    is_remote: null,
    salary_raw: null,
    salary_min: null,
    salary_max: null,
    description: null,
    posted_at: null,
    first_seen_at: "2026-07-09T00:00:00Z",
    last_seen_at: "2026-07-09T00:00:00Z",
    role_category: null,
    match_score: null,
    match_reasons: null,
    ats: "unknown",
    difficulty: "unknown",
    difficulty_reasons: null,
    status: "new",
    notes: null,
    dedup_hash: "hash",
    missing_streak: 0,
    notified_at: null,
    applied_at: null,
    dismissed_at: null,
    raw: null,
    ...overrides,
  };
}

/** A deps object whose anthropic never resolves (asserts 0-call paths). */
function neverCalledDeps(): ClassifierDeps & { fetchCalls: string[] } {
  const fetchCalls: string[] = [];
  return {
    fetchCalls,
    anthropic: {
      messages: {
        async create(): Promise<MessageResponse> {
          throw new Error("anthropic.messages.create must not be called");
        },
      },
    },
    fetchHtml: async (url: string) => {
      fetchCalls.push(url);
      throw new Error("fetchHtml must not be called");
    },
  };
}

// ---------------------------------------------------------------------------
// S1 — Prescreen excludes without any LLM call
// ---------------------------------------------------------------------------

describe("S1 — prescreen excludes without any LLM call", () => {
  it("excludes a .NET title and a no-keyword title with reasons and 0 calls", async () => {
    const jobA = makeJob({
      title: ".NET Developer",
      description: "Work with react and other tech",
    });
    const jobB = makeJob({
      title: "Registered Nurse",
      description: "Provide patient care in a hospital setting",
    });

    const anthropic = mockAnthropic(() => {
      throw new Error("should not call the model in prescreen-only case");
    });
    const deps: ClassifierDeps = { anthropic, fetchHtml: async () => "" };

    const { outcomes, errors } = await scoreMatch(
      [jobA, jobB],
      DEFAULT_CRITERIA,
      deps,
    );

    expect(errors).toEqual([]);
    const a = outcomes.find((o) => o.jobId === jobA.id)!;
    const b = outcomes.find((o) => o.jobId === jobB.id)!;

    expect(a.matchScore).toBe(0);
    expect(a.roleCategory).toBe("other");
    expect(a.matchReasons).toEqual(["prescreen:exclude:.net"]);

    expect(b.matchScore).toBe(0);
    expect(b.roleCategory).toBe("other");
    expect(b.matchReasons).toEqual(["prescreen:no-keyword-match"]);

    expect(anthropic.calls).toHaveLength(0);
  });

  it("prescreen() is a pure function returning excluded reasons", () => {
    const excluded = prescreen(
      makeJob({ title: ".NET Developer", description: "react" }),
      DEFAULT_CRITERIA,
    );
    expect(excluded).toEqual({ excluded: true, reason: "prescreen:exclude:.net" });

    const survivor = prescreen(
      makeJob({ title: "React Native Engineer", description: "expo mobile" }),
      DEFAULT_CRITERIA,
    );
    expect(survivor).toEqual({ excluded: false });
  });
});

// ---------------------------------------------------------------------------
// S2 — 20-job batch = exactly one haiku call updating all 20 rows
// ---------------------------------------------------------------------------

describe("S2 — 20-job batch is one haiku call updating all 20 rows", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, close } = await createPgliteTestDb());
  });
  afterEach(async () => {
    await close();
  });

  it("makes exactly one haiku call with criteria + 20 ids, persists all 20", async () => {
    // Insert 20 jobs whose titles each contain a role keyword, no excludes.
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const raw: RawJob = {
        source: "greenhouse",
        externalId: `gh-${i}`,
        url: `https://example.com/${i}`,
        title: `React Native Engineer ${i}`,
        company: `Company ${i}`,
        description: "Build mobile apps with react native and expo",
        raw: {},
      };
      const { job } = await upsertJob(db, raw);
      ids.push(job.id);
    }

    const fixture = await loadFixture("anthropic/score-batch-20.json");

    const anthropic = mockAnthropic((_params, _idx) =>
      remapScores(fixture, ids),
    );
    const deps: ClassifierDeps = { anthropic, fetchHtml: async () => "" };

    const stats = await classifyPendingJobs(db, DEFAULT_CRITERIA, deps);

    // Exactly one scoring call, haiku, prompt carries criteria JSON + all ids.
    expect(anthropic.calls).toHaveLength(1);
    const call = anthropic.calls[0];
    expect(call.model).toBe("claude-haiku-4-5");
    const prompt = call.messages.map((m) => String(m.content)).join("\n");
    expect(prompt).toContain(JSON.stringify(DEFAULT_CRITERIA));
    for (const id of ids) expect(prompt).toContain(id);

    expect(stats.scored).toBe(20);

    // All 20 rows persisted with valid values.
    const rows = await db.query(
      `select match_score, role_category, match_reasons from jobs where match_score is not null`,
    );
    expect(rows.rows).toHaveLength(20);
    const enums = ["react-native", "react", "frontend", "fullstack", "other"];
    for (const r of rows.rows) {
      expect(r.match_score).not.toBeNull();
      expect(r.match_score).toBeGreaterThanOrEqual(0);
      expect(r.match_score).toBeLessThanOrEqual(100);
      expect(enums).toContain(r.role_category);
      expect(r.match_reasons.length).toBeGreaterThanOrEqual(1);
      expect(r.match_reasons.length).toBeLessThanOrEqual(3);
    }
  });
});

// ---------------------------------------------------------------------------
// S3 — Ambiguous 40–70 score is re-scored once by sonnet
// ---------------------------------------------------------------------------

describe("S3 — ambiguous 40-70 score re-scored once by sonnet", () => {
  it("A (55) rescored by sonnet to 78; B (85) keeps haiku; total 2 calls", async () => {
    const jobA = makeJob({
      id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      title: "Frontend Engineer",
      description: "frontend ui engineer react",
    });
    const jobB = makeJob({
      id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      title: "React Native Engineer",
      description: "react native expo mobile",
    });

    const haiku = remapScores(
      await loadFixture("anthropic/score-ambiguous.json"),
      [jobA.id, jobB.id],
    );
    const sonnet = remapScores(
      await loadFixture("anthropic/rescore-sonnet.json"),
      [jobA.id],
    );

    const anthropic = mockAnthropic((params) =>
      params.model === "claude-sonnet-4-6" ? sonnet : haiku,
    );
    const deps: ClassifierDeps = { anthropic, fetchHtml: async () => "" };

    const { outcomes, errors } = await scoreMatch(
      [jobA, jobB],
      DEFAULT_CRITERIA,
      deps,
    );

    expect(errors).toEqual([]);

    // Exactly one haiku call and exactly one sonnet call.
    const haikuCalls = anthropic.calls.filter(
      (c) => c.model === "claude-haiku-4-5",
    );
    const sonnetCalls = anthropic.calls.filter(
      (c) => c.model === "claude-sonnet-4-6",
    );
    expect(haikuCalls).toHaveLength(1);
    expect(sonnetCalls).toHaveLength(1);
    expect(anthropic.calls).toHaveLength(2);

    const a = outcomes.find((o) => o.jobId === jobA.id)!;
    const b = outcomes.find((o) => o.jobId === jobB.id)!;

    // A gets the sonnet values (final regardless of value).
    expect(a.matchScore).toBe(78);
    expect(a.roleCategory).toBe("react");
    expect(a.matchReasons).toEqual([
      "on reflection a strong react match",
      "frontend adjacent",
    ]);

    // B keeps the haiku values.
    expect(b.matchScore).toBe(85);
    expect(b.roleCategory).toBe("react-native");
  });
});

// ---------------------------------------------------------------------------
// S4 — Greenhouse standard questions = easy with zero LLM calls
// ---------------------------------------------------------------------------

describe("S4 — Greenhouse standard questions = easy, 0 calls", () => {
  it("classifies easy from raw.questions with 0 model and 0 fetch calls", async () => {
    const questionsPayload = JSON.parse(
      await loadText("greenhouse/mattermost-5238290008-questions.json"),
    );
    const job = makeJob({
      source: "greenhouse",
      match_score: 80,
      apply_url: "https://job-boards.greenhouse.io/mattermost/jobs/5238290008",
      raw: questionsPayload,
    });

    const deps = neverCalledDeps();
    const { outcomes, errors } = await rankDifficulty([job], deps);

    expect(errors).toEqual([]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].difficulty).toBe("easy");
    expect(outcomes[0].difficultyReasons).toEqual([
      "greenhouse:standard-questions-only",
    ]);
    expect(deps.fetchCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// S5 — Greenhouse custom question = medium, still deterministic
// ---------------------------------------------------------------------------

describe("S5 — Greenhouse custom question = medium, deterministic", () => {
  it("classifies medium and names the first non-standard field, 0 calls", async () => {
    const questionsPayload = JSON.parse(
      await loadText("greenhouse/custom-questions.json"),
    );
    const job = makeJob({
      source: "greenhouse",
      match_score: 90,
      raw: questionsPayload,
    });

    const deps = neverCalledDeps();
    const { outcomes, errors } = await rankDifficulty([job], deps);

    expect(errors).toEqual([]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].difficulty).toBe("medium");
    expect(outcomes[0].difficultyReasons[0]).toMatch(
      /^greenhouse:custom-question:/,
    );
    expect(deps.fetchCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// S6 — HARD_ATS_DOMAINS match = hard with zero LLM calls
// ---------------------------------------------------------------------------

describe("S6 — HARD_ATS_DOMAINS match = hard, 0 calls", () => {
  it("classifies a myworkdayjobs.com apply_url as hard with 0 fetch/LLM", async () => {
    const job = makeJob({
      source: "lever",
      match_score: 70,
      apply_url:
        "https://acme.wd5.myworkdayjobs.com/en-US/careers/job/12345",
      raw: null,
    });

    const deps = neverCalledDeps();
    const { outcomes, errors } = await rankDifficulty([job], deps);

    expect(errors).toEqual([]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].difficulty).toBe("hard");
    expect(outcomes[0].difficultyReasons).toEqual([
      "hard-ats:myworkdayjobs.com",
    ]);
    expect(deps.fetchCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// S7 — Unknown apply page = LLM fallback invoked once, valid enum
// ---------------------------------------------------------------------------

describe("S7 — unknown apply page triggers one LLM fallback", () => {
  it("fetches once, calls haiku once with rubric refs, returns valid enum", async () => {
    const applyUrl =
      "https://jobs.lever.co/spotify/66acb66f-de37-4d95-a353-874db92838ef/apply";
    const html = await loadText("apply-pages/unknown-ats.html");
    const job = makeJob({
      source: "lever",
      match_score: 75,
      apply_url: applyUrl,
      raw: null,
    });

    const fixture = await loadFixture("anthropic/difficulty-fallback.json");
    const fetchCalls: string[] = [];
    const anthropic = mockAnthropic(() => fixture);
    const deps: ClassifierDeps = {
      anthropic,
      fetchHtml: async (url) => {
        fetchCalls.push(url);
        return html;
      },
    };

    const { outcomes, errors } = await rankDifficulty([job], deps);

    expect(errors).toEqual([]);
    // fetched exactly once with the job's apply_url
    expect(fetchCalls).toEqual([applyUrl]);
    // exactly one haiku call
    expect(anthropic.calls).toHaveLength(1);
    expect(anthropic.calls[0].model).toBe("claude-haiku-4-5");
    // prompt carries the reference examples verbatim
    const prompt = anthropic.calls[0].messages
      .map((m) => String(m.content))
      .join("\n");
    expect(prompt).toContain("mattermost");
    expect(prompt).toContain("Ulta Beauty");
    // valid enum + 1-3 reasons
    expect(["easy", "medium", "hard"]).toContain(outcomes[0].difficulty);
    expect(outcomes[0].difficultyReasons.length).toBeGreaterThanOrEqual(1);
    expect(outcomes[0].difficultyReasons.length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// S8 — Anthropic API failure: job stays unclassified, error recorded, run continues
// ---------------------------------------------------------------------------

describe("S8 — Anthropic failure: unclassified, error recorded, run continues", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, close } = await createPgliteTestDb());
  });
  afterEach(async () => {
    await close();
  });

  it("scoring 529 leaves 3 jobs NULL; fallback: first rejects, second classifies; both errors surface; run ok", async () => {
    // 3 scoring jobs (survive prescreen), match_score NULL.
    const scoreJobs: Job[] = [];
    for (let i = 0; i < 3; i++) {
      const raw: RawJob = {
        source: "greenhouse",
        externalId: `score-${i}`,
        url: `https://example.com/score-${i}`,
        title: `React Native Engineer ${i}`,
        company: `Co ${i}`,
        description: "react native expo",
        raw: {},
      };
      const { job } = await upsertJob(db, raw);
      scoreJobs.push(job);
    }

    // 2 difficulty-fallback jobs: non-greenhouse (or no questions),
    // apply_url not in HARD_ATS, match_score > 0 so they get ranked.
    const rankJobs: Job[] = [];
    for (let i = 0; i < 2; i++) {
      const raw: RawJob = {
        source: "lever",
        externalId: `rank-${i}`,
        url: `https://example.com/rank-${i}`,
        applyUrl: `https://jobs.lever.co/acme/rank-${i}/apply`,
        title: `React Native Engineer rank ${i}`,
        company: `Co ${i}`,
        description: "react native expo",
        raw: {},
      };
      const { job } = await upsertJob(db, raw);
      // Force these two into the ranking selection: score > 0, difficulty unknown.
      await db.query(
        `update jobs set match_score = 80, role_category = 'react-native', match_reasons = '{ok}' where id = $1`,
        [job.id],
      );
      rankJobs.push(job);
    }

    const diffFixture = await loadFixture("anthropic/difficulty-fallback.json");

    // Mock: any haiku SCORING call (3-job batch) rejects with 529.
    // The difficulty fallback: first call rejects, second resolves.
    let fallbackCall = 0;
    const anthropic = mockAnthropic((params) => {
      const prompt = params.messages.map((m) => String(m.content)).join("\n");
      if (prompt.includes("scoring job postings")) {
        // scoring batch → 529 overloaded
        return Promise.reject(overloadedError());
      }
      // difficulty fallback
      fallbackCall += 1;
      if (fallbackCall === 1) {
        return Promise.reject(overloadedError());
      }
      return diffFixture;
    });

    const deps: ClassifierDeps = {
      anthropic,
      fetchHtml: async () => "<html><body>apply here</body></html>",
    };

    // classify step must not throw
    const stats = await classifyPendingJobs(db, DEFAULT_CRITERIA, deps);

    // The 3 scoring jobs still have match_score NULL.
    for (const job of scoreJobs) {
      const r = await db.query(`select match_score from jobs where id = $1`, [
        job.id,
      ]);
      expect(r.rows[0].match_score).toBeNull();
    }

    // First fallback job stays difficulty unknown with NULL reasons; the
    // second is classified normally.
    const rankRows = await db.query(
      `select id, difficulty, difficulty_reasons from jobs where id = any($1::uuid[]) order by id`,
      [rankJobs.map((j) => j.id)],
    );
    const unknownCount = rankRows.rows.filter(
      (r) => r.difficulty === "unknown",
    ).length;
    const classifiedCount = rankRows.rows.filter(
      (r) => r.difficulty !== "unknown",
    ).length;
    expect(unknownCount).toBe(1);
    expect(classifiedCount).toBe(1);
    const stillUnknown = rankRows.rows.find((r) => r.difficulty === "unknown")!;
    expect(stillUnknown.difficulty_reasons).toBeNull();

    // Both error strings are present in the collected errors.
    expect(stats.errors.length).toBeGreaterThanOrEqual(2);
    const scoreErr = stats.errors.some((e) =>
      e.includes("haiku batch failed"),
    );
    const fallbackErr = stats.errors.some((e) =>
      e.includes("fallback failed"),
    );
    expect(scoreErr).toBe(true);
    expect(fallbackErr).toBe(true);

    // The run records the classifier stats and stays ok = true.
    const run = await recordCrawlRun(db, {
      startedAt: "2026-07-09T00:00:00Z",
      finishedAt: "2026-07-09T00:01:00Z",
      trigger: "manual",
      // fold the classifier stats into the run's stats JSON (spec 05 §2).
      stats: {
        classifier: {
          fetched: 0,
          new: 0,
          updated: 0,
          errors: stats.errors,
        },
      } as unknown as Record<
        string,
        { fetched: number; new: number; updated: number; errors: string[] }
      >,
      notifiedCount: 0,
      ok: true,
    });

    const readBack = await db.query(
      `select ok, stats->'classifier'->'errors' as classifier_errors from crawl_runs where id = $1`,
      [run.id],
    );
    expect(readBack.rows[0].ok).toBe(true);
    expect(readBack.rows[0].classifier_errors).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Sanity: applyMigrations is available (schema present for DB-backed tests)
// ---------------------------------------------------------------------------

describe("test harness", () => {
  it("applyMigrations export exists", () => {
    expect(typeof applyMigrations).toBe("function");
  });
  it("Criteria type is the contract default", () => {
    const c: Criteria = DEFAULT_CRITERIA;
    expect(c.exclude_keywords).toContain(".net");
  });
  it("vi is available for spies if needed", () => {
    const spy = vi.fn();
    spy();
    expect(spy).toHaveBeenCalled();
  });
});
