import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertJob, recordCrawlRun } from "../src/data.js";
import { createPgliteTestDb, type Db } from "../src/db.js";
import { listJobs, getJob, listCrawlRuns } from "../src/queries.js";
import type { RawJob } from "../src/schemas.js";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createPgliteTestDb());
});

afterEach(async () => {
  await close();
});

let _seq = 0;
function makeJob(overrides: Partial<RawJob> = {}): RawJob {
  const n = ++_seq;
  return {
    source: "greenhouse",
    externalId: `q-test-${n}`,
    url: `https://example.com/jobs/${n}`,
    title: `Job ${n}`,
    company: `Company ${n}`,
    location: "Remote",
    raw: { id: n },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// listJobs — filtering
// ---------------------------------------------------------------------------
describe("listJobs — filtering", () => {
  it("returns only rows matching status filter", async () => {
    const { job: j1 } = await upsertJob(db, makeJob({ externalId: "filter-s-1" }));
    const { job: j2 } = await upsertJob(db, makeJob({ externalId: "filter-s-2" }));
    // j1 stays new; transition j2 to queued
    await db.query(`UPDATE jobs SET status = 'queued' WHERE id = $1`, [j2.id]);

    const result = await listJobs(db, { status: "queued" });
    expect(result.rows.every((r) => r.status === "queued")).toBe(true);
    expect(result.rows.some((r) => r.id === j1.id)).toBe(false);
    expect(result.rows.some((r) => r.id === j2.id)).toBe(true);
  });

  it("returns only rows matching difficulty filter", async () => {
    await upsertJob(db, makeJob({ externalId: "filter-d-1" }));
    const { job: j2 } = await upsertJob(db, makeJob({ externalId: "filter-d-2" }));
    await db.query(`UPDATE jobs SET difficulty = 'easy' WHERE id = $1`, [j2.id]);

    const result = await listJobs(db, { difficulty: "easy" });
    expect(result.rows.every((r) => r.difficulty === "easy")).toBe(true);
    expect(result.rows.some((r) => r.id === j2.id)).toBe(true);
  });

  it("combines multiple filters with AND", async () => {
    const { job: j1 } = await upsertJob(db, makeJob({ externalId: "filter-and-1" }));
    const { job: j2 } = await upsertJob(db, makeJob({ externalId: "filter-and-2" }));
    // j1: queued + easy, j2: queued + hard
    await db.query(`UPDATE jobs SET status = 'queued', difficulty = 'easy' WHERE id = $1`, [j1.id]);
    await db.query(`UPDATE jobs SET status = 'queued', difficulty = 'hard' WHERE id = $1`, [j2.id]);

    const result = await listJobs(db, { status: "queued", difficulty: "easy" });
    expect(result.rows.some((r) => r.id === j1.id)).toBe(true);
    expect(result.rows.some((r) => r.id === j2.id)).toBe(false);
  });

  it("returns all rows when no filters supplied", async () => {
    await upsertJob(db, makeJob({ externalId: "filter-all-1" }));
    await upsertJob(db, makeJob({ externalId: "filter-all-2" }));
    const result = await listJobs(db, {});
    expect(result.total).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// listJobs — pagination (limit / offset / total)
// ---------------------------------------------------------------------------
describe("listJobs — pagination", () => {
  it("respects limit and offset, total reflects full count", async () => {
    // Insert 5 jobs
    for (let i = 0; i < 5; i++) {
      await upsertJob(db, makeJob({ externalId: `pag-${i}` }));
    }
    const page1 = await listJobs(db, { limit: 3, offset: 0 });
    const page2 = await listJobs(db, { limit: 3, offset: 3 });

    expect(page1.rows.length).toBe(3);
    expect(page2.rows.length).toBeGreaterThanOrEqual(2); // at least 2 of the 5

    // No overlap
    const ids1 = new Set(page1.rows.map((r) => r.id));
    for (const r of page2.rows) {
      expect(ids1.has(r.id)).toBe(false);
    }

    // Total is the same for both pages
    expect(page1.total).toBe(page2.total);
    expect(page1.total).toBeGreaterThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// listJobs — sort order
// ---------------------------------------------------------------------------
describe("listJobs — sort order", () => {
  it("sorts by first_seen_at desc by default", async () => {
    // Insert two jobs; the second will have a later first_seen_at due to now()
    const { job: j1 } = await upsertJob(db, makeJob({ externalId: "sort-a-1" }));
    // Force a distinct timestamp gap
    await db.query(
      `UPDATE jobs SET first_seen_at = now() - interval '1 hour' WHERE id = $1`,
      [j1.id],
    );
    const { job: j2 } = await upsertJob(db, makeJob({ externalId: "sort-a-2" }));

    const result = await listJobs(db, { sort: "first_seen_at", dir: "desc", limit: 10 });
    const ids = result.rows.map((r) => r.id);
    const pos1 = ids.indexOf(j1.id);
    const pos2 = ids.indexOf(j2.id);
    expect(pos2).toBeLessThan(pos1); // j2 (newer) comes first
  });

  it("sorts by match_score desc", async () => {
    const { job: j1 } = await upsertJob(db, makeJob({ externalId: "sort-ms-1" }));
    const { job: j2 } = await upsertJob(db, makeJob({ externalId: "sort-ms-2" }));
    await db.query(`UPDATE jobs SET match_score = 80 WHERE id = $1`, [j1.id]);
    await db.query(`UPDATE jobs SET match_score = 40 WHERE id = $1`, [j2.id]);

    const result = await listJobs(db, { sort: "match_score", dir: "desc", limit: 10 });
    const ids = result.rows.map((r) => r.id);
    const pos1 = ids.indexOf(j1.id);
    const pos2 = ids.indexOf(j2.id);
    expect(pos1).toBeLessThan(pos2); // j1 (score 80) comes before j2 (score 40)
  });
});

// ---------------------------------------------------------------------------
// getJob — hit and miss
// ---------------------------------------------------------------------------
describe("getJob", () => {
  it("returns the job when it exists", async () => {
    const { job } = await upsertJob(db, makeJob({ externalId: "getjob-hit" }));
    const found = await getJob(db, job.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(job.id);
    expect(found!.external_id).toBe("getjob-hit");
  });

  it("returns null for a non-existent id", async () => {
    const result = await getJob(db, "00000000-0000-0000-0000-000000000000");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listCrawlRuns — newest first
// ---------------------------------------------------------------------------
describe("listCrawlRuns", () => {
  it("returns runs newest first", async () => {
    const r1 = await recordCrawlRun(db, {
      startedAt: "2026-01-01T00:00:00Z",
      finishedAt: "2026-01-01T00:01:00Z",
      trigger: "manual",
      stats: {},
      notifiedCount: 0,
      ok: true,
    });
    const r2 = await recordCrawlRun(db, {
      startedAt: "2026-01-02T00:00:00Z",
      finishedAt: "2026-01-02T00:01:00Z",
      trigger: "launchd",
      stats: {},
      notifiedCount: 1,
      ok: true,
    });

    const runs = await listCrawlRuns(db);
    const ids = runs.map((r) => r.id);
    expect(ids.indexOf(r2.id)).toBeLessThan(ids.indexOf(r1.id)); // r2 (newer) first
  });

  it("respects the limit option", async () => {
    for (let i = 0; i < 5; i++) {
      await recordCrawlRun(db, {
        startedAt: `2026-01-0${i + 1}T00:00:00Z`,
        finishedAt: `2026-01-0${i + 1}T00:01:00Z`,
        trigger: "manual",
        stats: {},
        notifiedCount: 0,
        ok: true,
      });
    }
    const runs = await listCrawlRuns(db, { limit: 2 });
    expect(runs.length).toBe(2);
  });
});
