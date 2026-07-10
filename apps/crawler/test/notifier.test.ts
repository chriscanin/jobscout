/**
 * Notifier tests — S1 through S9 from 06-notifier.atdd.md.
 *
 * All tests use PGlite (in-process Postgres, no network), a mocked fetchImpl
 * (no real Discord calls), and the real data layer from @jobscout/core.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPgliteTestDb,
  type Db,
  DEFAULT_CRITERIA,
  type Criteria,
  upsertJob,
  markNotified,
  type RawJob,
} from "@jobscout/core";
import { notifyNewMatches } from "../src/notifier.js";
import { dedupHash } from "@jobscout/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: Db;
let closeDb: () => Promise<void>;

beforeEach(async () => {
  // createPgliteTestDb applies all migrations, which seeds the criteria row (id = 1).
  ({ db, close: closeDb } = await createPgliteTestDb());
});

afterEach(async () => {
  await closeDb();
});

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Counter wrapper around a static Response sequence. */
function makeMockFetch(responses: Response[]): {
  fetchImpl: FetchImpl;
  callCount: () => number;
} {
  let idx = 0;
  let count = 0;
  const fetchImpl: FetchImpl = async (_input, _init) => {
    count++;
    const resp = responses[idx];
    if (resp === undefined) {
      throw new Error(`makeMockFetch: no response at index ${idx} (call #${count})`);
    }
    idx++;
    return resp.clone();
  };
  return { fetchImpl, callCount: () => count };
}

/** Build a 200 success Response (represents Discord's 2xx on webhook execute).
 *  Note: Node 22's Response constructor rejects null-body statuses (204/304),
 *  so we use 200 here — the notifier accepts any 2xx. */
function ok204(): Response {
  return new Response("", { status: 200 });
}

/** Build a 429 rate-limit Response matching the captured fixture. */
function rateLimit429(retryAfter = 1.3): Response {
  return new Response(
    JSON.stringify({ message: "You are being rate limited.", retry_after: retryAfter, global: false }),
    { status: 429, headers: { "Content-Type": "application/json" } },
  );
}

/** Build a 500 error Response. */
function serverError500(): Response {
  return new Response("Internal Server Error", { status: 500 });
}

const WEBHOOK_URL = "https://discord.com/api/webhooks/test/hook";

const CRITERIA: Criteria = DEFAULT_CRITERIA; // notify_min_score = 60

/**
 * Insert a job into the DB via upsertJob and optionally mark it notified.
 * Returns the inserted job row.
 */
async function insertJob(raw: RawJob): Promise<import("@jobscout/core").Job> {
  const { job } = await upsertJob(db, raw);
  return job;
}

/**
 * Apply classification columns directly via SQL (upsertJob doesn't set them).
 */
async function classify(
  jobId: string,
  opts: {
    match_score?: number;
    role_category?: string | null;
    difficulty?: string;
    difficulty_reasons?: string[] | null;
    match_reasons?: string[] | null;
    remote_us_ok?: boolean | null;
  },
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let p = 1;

  if (opts.match_score !== undefined) {
    sets.push(`match_score = $${p++}`);
    params.push(opts.match_score);
  }
  if ("role_category" in opts) {
    sets.push(`role_category = $${p++}`);
    params.push(opts.role_category ?? null);
  }
  if (opts.difficulty !== undefined) {
    sets.push(`difficulty = $${p++}`);
    params.push(opts.difficulty);
  }
  if ("difficulty_reasons" in opts) {
    sets.push(`difficulty_reasons = $${p++}`);
    params.push(opts.difficulty_reasons ?? null);
  }
  if ("match_reasons" in opts) {
    sets.push(`match_reasons = $${p++}`);
    params.push(opts.match_reasons ?? null);
  }
  // Default remote_us_ok to true (the notify gate) unless the test overrides it,
  // so the eligibility/ordering/cap/dedup fixtures still notify. Tests that check
  // the gate pass an explicit false/null.
  sets.push(`remote_us_ok = $${p++}`);
  params.push("remote_us_ok" in opts ? (opts.remote_us_ok ?? null) : true);

  if (sets.length === 0) return;
  params.push(jobId);
  await db.query(
    `update jobs set ${sets.join(", ")} where id = $${p}`,
    params as any[],
  );
}

async function getJob(id: string): Promise<import("@jobscout/core").Job> {
  const r = await db.query(`select * from jobs where id = $1`, [id]);
  return r.rows[0] as import("@jobscout/core").Job;
}

/** Build a minimal RawJob with a unique externalId. */
let _seq = 0;
function rawJob(overrides: Partial<RawJob> = {}): RawJob {
  const seq = ++_seq;
  return {
    source: "greenhouse",
    externalId: `ext-${seq}`,
    url: `https://example.com/jobs/${seq}`,
    title: `Job ${seq}`,
    company: `Company ${seq}`,
    raw: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// S1 — Happy path: eligible jobs are posted and marked notified
// ---------------------------------------------------------------------------
describe("S1 — happy path", () => {
  it("posts one message with 2 embeds and marks both jobs notified", async () => {
    const { fetchImpl, callCount } = makeMockFetch([ok204()]);

    const j1 = await insertJob(rawJob({ title: "Job A", company: "Acme" }));
    await classify(j1.id, { match_score: 85, role_category: "react-native", difficulty: "easy" });

    const j2 = await insertJob(rawJob({ title: "Job B", company: "Acme" }));
    await classify(j2.id, { match_score: 70, role_category: "react-native", difficulty: "easy" });

    const result = await notifyNewMatches({
      data: db,
      criteria: CRITERIA,
      webhookUrl: WEBHOOK_URL,
      fetchImpl,
    });

    expect(callCount()).toBe(1);
    expect(result).toEqual({ notifiedCount: 2, eligibleCount: 2 });

    const r1 = await getJob(j1.id);
    const r2 = await getJob(j2.id);
    expect(r1.status).toBe("notified");
    expect(r1.notified_at).not.toBeNull();
    expect(r2.status).toBe("notified");
    expect(r2.notified_at).not.toBeNull();
  });

  it("posts embeds in score-desc order (85 first)", async () => {
    let capturedBody: any;
    const fetchImpl: FetchImpl = async (_input, init) => {
      capturedBody = JSON.parse(init!.body as string);
      return ok204();
    };

    const j1 = await insertJob(rawJob({ title: "Low Score", company: "Acme" }));
    await classify(j1.id, { match_score: 70, role_category: "react-native", difficulty: "easy" });

    const j2 = await insertJob(rawJob({ title: "High Score", company: "Acme" }));
    await classify(j2.id, { match_score: 85, role_category: "react-native", difficulty: "easy" });

    await notifyNewMatches({ data: db, criteria: CRITERIA, webhookUrl: WEBHOOK_URL, fetchImpl });

    expect(capturedBody.embeds).toHaveLength(2);
    expect(capturedBody.embeds[0].fields.find((f: any) => f.name === "match_score").value).toBe("85");
    expect(capturedBody.embeds[1].fields.find((f: any) => f.name === "match_score").value).toBe("70");
  });
});

// ---------------------------------------------------------------------------
// S2 — Eligibility filtering
// ---------------------------------------------------------------------------
describe("S2 — eligibility filtering", () => {
  it("notifies only C (fullstack easy) and F (frontend unknown)", async () => {
    // A: score 55, react-native, easy — below threshold
    const jA = await insertJob(rawJob({ title: "A", company: "Co" }));
    await classify(jA.id, { match_score: 55, role_category: "react-native", difficulty: "easy" });

    // B: score 80, fullstack (priority 3), medium — fails priority/difficulty rule
    const jB = await insertJob(rawJob({ title: "B", company: "CoB" }));
    await classify(jB.id, { match_score: 80, role_category: "fullstack", difficulty: "medium" });

    // C: score 80, fullstack (priority 3), easy — passes (difficulty = easy)
    const jC = await insertJob(rawJob({ title: "C", company: "CoC" }));
    await classify(jC.id, { match_score: 80, role_category: "fullstack", difficulty: "easy" });

    // E: already-notified job (queued status) with same dedup_hash as D
    const hashDE = dedupHash("CoDE", "D Job", "Remote");
    const jE = await insertJob(rawJob({ title: "D Job", company: "CoDE", location: "Remote" }));
    await classify(jE.id, { match_score: 90, role_category: "react", difficulty: "hard" });
    await markNotified(db, jE.id);
    await db.query(`update jobs set status = 'queued' where id = $1`, [jE.id]);

    // D: score 90, react (priority 2), hard — suppressed by dedup (E is notified)
    // Use same dedup_hash as E by using same company/title/location
    const jD = await insertJob(
      rawJob({ title: "D Job", company: "CoDE", location: "Remote", source: "lever", externalId: "lever-D" }),
    );
    await classify(jD.id, { match_score: 90, role_category: "react", difficulty: "hard" });

    // F: score 70, frontend (priority 2), unknown — passes
    const jF = await insertJob(rawJob({ title: "F", company: "CoF" }));
    await classify(jF.id, { match_score: 70, role_category: "frontend", difficulty: "unknown" });

    let capturedBody: any;
    const fetchImpl: FetchImpl = async (_input, init) => {
      capturedBody = JSON.parse(init!.body as string);
      return ok204();
    };

    const result = await notifyNewMatches({
      data: db,
      criteria: CRITERIA,
      webhookUrl: WEBHOOK_URL,
      fetchImpl,
    });

    // Should notify C (score 80) and F (score 70)
    expect(capturedBody.embeds).toHaveLength(2);
    const embedTitles = capturedBody.embeds.map((e: any) => e.title as string);
    expect(embedTitles.some((t: string) => t.startsWith("C"))).toBe(true);
    expect(embedTitles.some((t: string) => t.startsWith("F"))).toBe(true);

    // A, B, D stay new with no notified_at
    const rA = await getJob(jA.id);
    const rB = await getJob(jB.id);
    const rD = await getJob(jD.id);
    expect(rA.status).toBe("new");
    expect(rA.notified_at).toBeNull();
    expect(rB.status).toBe("new");
    expect(rB.notified_at).toBeNull();
    expect(rD.status).toBe("new");
    expect(rD.notified_at).toBeNull();

    expect(result.notifiedCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// S3 — Embed shape: exact JSON snapshot
// ---------------------------------------------------------------------------
describe("S3 — embed shape snapshot", () => {
  it("produces the exact embed for the Mattermost job", async () => {
    const j = await insertJob({
      source: "greenhouse",
      externalId: "5238290008",
      url: "https://job-boards.greenhouse.io/mattermost/jobs/5238290008",
      applyUrl: "https://job-boards.greenhouse.io/mattermost/jobs/5238290008#app",
      title: "Senior React Native Engineer",
      company: "Mattermost",
      location: "Remote, US",
      salaryRaw: "$150,000 - $180,000",
      raw: {},
    });
    await classify(j.id, {
      match_score: 85,
      role_category: "react-native",
      difficulty: "easy",
      difficulty_reasons: ["standard Greenhouse fields only"],
    });

    let capturedBody: any;
    const fetchImpl: FetchImpl = async (_input, init) => {
      capturedBody = JSON.parse(init!.body as string);
      return ok204();
    };

    await notifyNewMatches({ data: db, criteria: CRITERIA, webhookUrl: WEBHOOK_URL, fetchImpl });

    expect(capturedBody.embeds).toHaveLength(1);
    expect(capturedBody.embeds[0]).toEqual({
      title: "Senior React Native Engineer at Mattermost",
      url: "https://job-boards.greenhouse.io/mattermost/jobs/5238290008",
      color: 3066993, // 0x2ECC71 easy
      fields: [
        { name: "match_score", value: "85", inline: true },
        { name: "role_category", value: "react-native", inline: true },
        { name: "location", value: "Remote, US", inline: true },
        { name: "salary_raw", value: "$150,000 - $180,000", inline: true },
        { name: "difficulty", value: "easy — standard Greenhouse fields only", inline: true },
        { name: "apply", value: "[apply](https://job-boards.greenhouse.io/mattermost/jobs/5238290008#app)", inline: true },
      ],
    });
  });

  it("omits location, salary, apply for null fields and uses unknown color", async () => {
    const j = await insertJob(rawJob({ title: "Plain Job", company: "AnonCo" }));
    await classify(j.id, {
      match_score: 65,
      role_category: "react-native",
      difficulty: "unknown",
      difficulty_reasons: null,
    });

    let capturedBody: any;
    const fetchImpl: FetchImpl = async (_input, init) => {
      capturedBody = JSON.parse(init!.body as string);
      return ok204();
    };

    await notifyNewMatches({ data: db, criteria: CRITERIA, webhookUrl: WEBHOOK_URL, fetchImpl });

    const embed = capturedBody.embeds[0];
    expect(embed.color).toBe(9807270); // 0x95A5A6
    const fieldNames = embed.fields.map((f: any) => f.name);
    expect(fieldNames).toEqual(["match_score", "role_category", "difficulty"]);
    expect(embed.fields.find((f: any) => f.name === "difficulty").value).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// S4 — Batching: 23 eligible jobs → 3 messages of 10/10/3
// ---------------------------------------------------------------------------
describe("S4 — batching 23 jobs into 3 messages", () => {
  it("sends 3 POSTs with embed counts [10, 10, 3] and no content field", async () => {
    // Insert 23 eligible jobs.
    for (let i = 0; i < 23; i++) {
      const j = await insertJob(rawJob());
      await classify(j.id, { match_score: 75, role_category: "react-native", difficulty: "easy" });
    }

    const bodies: any[] = [];
    const fetchImpl: FetchImpl = async (_input, init) => {
      bodies.push(JSON.parse(init!.body as string));
      return ok204();
    };

    const result = await notifyNewMatches({
      data: db,
      criteria: CRITERIA,
      webhookUrl: WEBHOOK_URL,
      fetchImpl,
    });

    expect(bodies).toHaveLength(3);
    expect(bodies[0].embeds).toHaveLength(10);
    expect(bodies[1].embeds).toHaveLength(10);
    expect(bodies[2].embeds).toHaveLength(3);
    expect(bodies[0].content).toBeUndefined();
    expect(bodies[1].content).toBeUndefined();
    expect(bodies[2].content).toBeUndefined();
    expect(result.notifiedCount).toBe(23);
    expect(result.eligibleCount).toBe(23);
  });
});

// ---------------------------------------------------------------------------
// S5 — Cap at 30 with overflow line
// ---------------------------------------------------------------------------
describe("S5 — cap at 30 with overflow", () => {
  it("posts 3 messages for top 30, overflow line on last, 5 stay new", async () => {
    // 30 jobs with score 90
    const top30Ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      const j = await insertJob(rawJob());
      await classify(j.id, { match_score: 90, role_category: "react-native", difficulty: "easy" });
      top30Ids.push(j.id);
    }
    // 5 jobs with score 61
    const bottom5Ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const j = await insertJob(rawJob());
      await classify(j.id, { match_score: 61, role_category: "react-native", difficulty: "easy" });
      bottom5Ids.push(j.id);
    }

    const bodies: any[] = [];
    const fetchImpl: FetchImpl = async (_input, init) => {
      bodies.push(JSON.parse(init!.body as string));
      return ok204();
    };

    const result = await notifyNewMatches({
      data: db,
      criteria: CRITERIA,
      webhookUrl: WEBHOOK_URL,
      fetchImpl,
    });

    expect(bodies).toHaveLength(3);
    expect(bodies[0].embeds).toHaveLength(10);
    expect(bodies[1].embeds).toHaveLength(10);
    expect(bodies[2].embeds).toHaveLength(10);
    expect(bodies[0].content).toBeUndefined();
    expect(bodies[1].content).toBeUndefined();
    expect(bodies[2].content).toBe("+5 more in the admin");

    // top 30 notified
    for (const id of top30Ids) {
      const job = await getJob(id);
      expect(job.status).toBe("notified");
    }
    // bottom 5 still new
    for (const id of bottom5Ids) {
      const job = await getJob(id);
      expect(job.status).toBe("new");
    }

    expect(result).toEqual({ notifiedCount: 30, eligibleCount: 35 });
  });
});

// ---------------------------------------------------------------------------
// S6 — Partial failure: message 2 of 3 fails
// ---------------------------------------------------------------------------
describe("S6 — partial failure recovery", () => {
  it("notifies batch 1 jobs, leaves rest new when batch 2 returns 500", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 23; i++) {
      const j = await insertJob(rawJob());
      await classify(j.id, { match_score: 75, role_category: "react-native", difficulty: "easy" });
      ids.push(j.id);
    }

    // POST #1 → 2xx, POST #2 → 500
    const { fetchImpl, callCount } = makeMockFetch([ok204(), serverError500()]);

    const result = await notifyNewMatches({
      data: db,
      criteria: CRITERIA,
      webhookUrl: WEBHOOK_URL,
      fetchImpl,
    });

    expect(callCount()).toBe(2);
    expect(result.notifiedCount).toBe(10);

    // We need the actual job order to know which 10 got notified.
    // Select all jobs sorted by match_score desc, first_seen_at asc, id asc
    const allJobs = await db.query(
      `select id, status from jobs order by match_score desc, first_seen_at asc, id asc`,
    );
    const rows = allJobs.rows;
    for (let i = 0; i < 10; i++) {
      expect(rows[i].status).toBe("notified");
    }
    for (let i = 10; i < 23; i++) {
      expect(rows[i].status).toBe("new");
    }
  });

  it("second run posts only remaining 13 jobs in 2 messages", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 23; i++) {
      const j = await insertJob(rawJob());
      await classify(j.id, { match_score: 75, role_category: "react-native", difficulty: "easy" });
      ids.push(j.id);
    }

    // First run: batch 1 succeeds, batch 2 fails
    await notifyNewMatches({
      data: db,
      criteria: CRITERIA,
      webhookUrl: WEBHOOK_URL,
      fetchImpl: makeMockFetch([ok204(), serverError500()]).fetchImpl,
    });

    // Second run: all succeed
    const bodies: any[] = [];
    const { fetchImpl: fetchImpl2, callCount: callCount2 } = makeMockFetch([ok204(), ok204()]);
    const fetchCapture: FetchImpl = async (url, init) => {
      bodies.push(JSON.parse((init!.body as string)));
      return fetchImpl2(url, init);
    };

    const result2 = await notifyNewMatches({
      data: db,
      criteria: CRITERIA,
      webhookUrl: WEBHOOK_URL,
      fetchImpl: fetchCapture,
    });

    expect(bodies).toHaveLength(2);
    expect(bodies[0].embeds).toHaveLength(10);
    expect(bodies[1].embeds).toHaveLength(3);
    expect(result2.notifiedCount).toBe(13);

    // Verify none of the first 10 notified jobs appear again
    const allJobs = await db.query(
      `select id, status, notified_at from jobs order by match_score desc, first_seen_at asc, id asc`,
    );
    for (const row of allJobs.rows) {
      expect(row.status).toBe("notified");
    }
  });
});

// ---------------------------------------------------------------------------
// S7 — 429: honor retry_after once
// ---------------------------------------------------------------------------
describe("S7 — 429 retry_after handling", () => {
  it("sleeps retry_after ms and retries; success → all 5 notified", async () => {
    for (let i = 0; i < 5; i++) {
      const j = await insertJob(rawJob());
      await classify(j.id, { match_score: 75, role_category: "react-native", difficulty: "easy" });
    }

    const sleepCalls: number[] = [];
    const fakeSleep = async (ms: number) => { sleepCalls.push(ms); };

    // Response sequence: 429, then 2xx
    const { fetchImpl, callCount } = makeMockFetch([rateLimit429(1.3), ok204()]);

    const result = await notifyNewMatches({
      data: db,
      criteria: CRITERIA,
      webhookUrl: WEBHOOK_URL,
      fetchImpl,
      sleep: fakeSleep,
    });

    expect(callCount()).toBe(2);
    expect(sleepCalls).toHaveLength(1);
    expect(sleepCalls[0]).toBe(1300); // 1.3 * 1000
    expect(result.notifiedCount).toBe(5);

    const allJobs = await db.query(`select status from jobs`);
    for (const row of allJobs.rows) {
      expect(row.status).toBe("notified");
    }
  });

  it("429 then another 429 → 2 POSTs, no retry 3, all jobs stay new", async () => {
    for (let i = 0; i < 5; i++) {
      const j = await insertJob(rawJob());
      await classify(j.id, { match_score: 75, role_category: "react-native", difficulty: "easy" });
    }

    const sleepCalls: number[] = [];
    const fakeSleep = async (ms: number) => { sleepCalls.push(ms); };

    const { fetchImpl, callCount } = makeMockFetch([rateLimit429(1.3), rateLimit429(1.3)]);

    const result = await notifyNewMatches({
      data: db,
      criteria: CRITERIA,
      webhookUrl: WEBHOOK_URL,
      fetchImpl,
      sleep: fakeSleep,
    });

    expect(callCount()).toBe(2); // no third attempt
    expect(sleepCalls).toHaveLength(1);
    expect(result.notifiedCount).toBe(0);

    const allJobs = await db.query(`select status, notified_at from jobs`);
    for (const row of allJobs.rows) {
      expect(row.status).toBe("new");
      expect(row.notified_at).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// S8 — Nothing to send → zero HTTP calls
// ---------------------------------------------------------------------------
describe("S8 — zero eligible", () => {
  it("makes no HTTP calls when no jobs are eligible", async () => {
    // Job below threshold
    const j1 = await insertJob(rawJob());
    await classify(j1.id, { match_score: 50, role_category: "react-native", difficulty: "easy" });

    // Job already notified
    const j2 = await insertJob(rawJob({ title: "Already Done", company: "AnotherCo" }));
    await classify(j2.id, { match_score: 80, role_category: "react-native", difficulty: "easy" });
    await markNotified(db, j2.id);

    const { fetchImpl, callCount } = makeMockFetch([]);

    const result = await notifyNewMatches({
      data: db,
      criteria: CRITERIA,
      webhookUrl: WEBHOOK_URL,
      fetchImpl,
    });

    expect(callCount()).toBe(0);
    expect(result).toEqual({ notifiedCount: 0, eligibleCount: 0 });
  });

  it("makes no HTTP calls on second run after fully successful S1", async () => {
    // Set up two jobs and run once
    const j1 = await insertJob(rawJob({ title: "First", company: "Acme" }));
    await classify(j1.id, { match_score: 85, role_category: "react-native", difficulty: "easy" });
    const j2 = await insertJob(rawJob({ title: "Second", company: "Acme2" }));
    await classify(j2.id, { match_score: 70, role_category: "react-native", difficulty: "easy" });

    const { fetchImpl: fetch1 } = makeMockFetch([ok204()]);
    await notifyNewMatches({ data: db, criteria: CRITERIA, webhookUrl: WEBHOOK_URL, fetchImpl: fetch1 });

    // Capture notified_at values
    const r1Before = await getJob(j1.id);
    const r2Before = await getJob(j2.id);

    // Second run
    const { fetchImpl: fetch2, callCount: count2 } = makeMockFetch([]);
    const result2 = await notifyNewMatches({
      data: db,
      criteria: CRITERIA,
      webhookUrl: WEBHOOK_URL,
      fetchImpl: fetch2,
    });

    expect(count2()).toBe(0);
    expect(result2).toEqual({ notifiedCount: 0, eligibleCount: 0 });

    // notified_at unchanged
    const r1After = await getJob(j1.id);
    const r2After = await getJob(j2.id);
    expect(r1After.notified_at).toEqual(r1Before.notified_at);
    expect(r2After.notified_at).toEqual(r2Before.notified_at);
  });
});

// ---------------------------------------------------------------------------
// S9 — Same-run dedup collision
// ---------------------------------------------------------------------------
describe("S9 — same-run dedup collision", () => {
  it("posts only the higher-score twin and leaves the other new", async () => {
    // Two jobs sharing the same dedup_hash (same title/company/location)
    const j1 = await insertJob({
      source: "greenhouse",
      externalId: "twin-1",
      url: "https://example.com/job/twin-1",
      title: "React Native Engineer",
      company: "TwinCo",
      location: "Remote",
      raw: {},
    });
    await classify(j1.id, { match_score: 80, role_category: "react-native", difficulty: "easy" });

    const j2 = await insertJob({
      source: "lever",
      externalId: "twin-2",
      url: "https://example.com/job/twin-2",
      title: "React Native Engineer",
      company: "TwinCo",
      location: "Remote",
      raw: {},
    });
    await classify(j2.id, { match_score: 75, role_category: "react-native", difficulty: "easy" });

    // Verify they share a dedup_hash
    const r1 = await getJob(j1.id);
    const r2 = await getJob(j2.id);
    expect(r1.dedup_hash).toBe(r2.dedup_hash);

    let capturedBody: any;
    const fetchImpl: FetchImpl = async (_input, init) => {
      capturedBody = JSON.parse(init!.body as string);
      return ok204();
    };

    const result = await notifyNewMatches({
      data: db,
      criteria: CRITERIA,
      webhookUrl: WEBHOOK_URL,
      fetchImpl,
    });

    // Only one embed — the score-80 job
    expect(capturedBody.embeds).toHaveLength(1);
    expect(capturedBody.embeds[0].fields.find((f: any) => f.name === "match_score").value).toBe("80");

    expect(result).toEqual({ notifiedCount: 1, eligibleCount: 1 });

    const after1 = await getJob(j1.id);
    const after2 = await getJob(j2.id);
    expect(after1.status).toBe("notified");
    expect(after1.notified_at).not.toBeNull();
    expect(after2.status).toBe("new");
    expect(after2.notified_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// S10 — remote_us_ok gate (CONTRACT §Location filter)
// ---------------------------------------------------------------------------
describe("S10 — remote_us_ok gates notification", () => {
  it("does not notify a perfect match whose remote_us_ok is false", async () => {
    // Perfect match: score 90, react-native (priority 1), easy — but not remote/US.
    const j = await insertJob(rawJob({ title: "RN Onsite", company: "OnsiteCo" }));
    await classify(j.id, {
      match_score: 90,
      role_category: "react-native",
      difficulty: "easy",
      remote_us_ok: false,
    });

    const { fetchImpl, callCount } = makeMockFetch([]);
    const result = await notifyNewMatches({
      data: db,
      criteria: CRITERIA,
      webhookUrl: WEBHOOK_URL,
      fetchImpl,
    });

    expect(callCount()).toBe(0);
    expect(result).toEqual({ notifiedCount: 0, eligibleCount: 0 });
    const after = await getJob(j.id);
    expect(after.status).toBe("new");
    expect(after.notified_at).toBeNull();
  });

  it("does not notify a perfect match whose remote_us_ok is null (not yet judged)", async () => {
    const j = await insertJob(rawJob({ title: "RN Unjudged", company: "UnjudgedCo" }));
    await classify(j.id, {
      match_score: 90,
      role_category: "react-native",
      difficulty: "easy",
      remote_us_ok: null,
    });

    const { fetchImpl, callCount } = makeMockFetch([]);
    const result = await notifyNewMatches({
      data: db,
      criteria: CRITERIA,
      webhookUrl: WEBHOOK_URL,
      fetchImpl,
    });

    expect(callCount()).toBe(0);
    expect(result).toEqual({ notifiedCount: 0, eligibleCount: 0 });
    const after = await getJob(j.id);
    expect(after.status).toBe("new");
  });

  it("notifies an otherwise-identical match whose remote_us_ok is true", async () => {
    const j = await insertJob(rawJob({ title: "RN Remote US", company: "RemoteCo" }));
    await classify(j.id, {
      match_score: 90,
      role_category: "react-native",
      difficulty: "easy",
      remote_us_ok: true,
    });

    const { fetchImpl, callCount } = makeMockFetch([ok204()]);
    const result = await notifyNewMatches({
      data: db,
      criteria: CRITERIA,
      webhookUrl: WEBHOOK_URL,
      fetchImpl,
    });

    expect(callCount()).toBe(1);
    expect(result).toEqual({ notifiedCount: 1, eligibleCount: 1 });
    const after = await getJob(j.id);
    expect(after.status).toBe("notified");
    expect(after.notified_at).not.toBeNull();
  });
});
