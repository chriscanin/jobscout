/**
 * Tests for the Remotive adapter.
 *
 * Scenarios covered:
 *  1. Happy path: jobs map to RawJobs with exact field mapping
 *  2. Empty salary string → salaryRaw undefined
 *  3. Non-200 response → recordError called, [] returned, no throw
 *
 * All tests run fully offline: ctx.fetch is stubbed from inline fixtures.
 */

import { describe, it, expect, vi } from "vitest";
import { remotiveAdapter } from "../../src/adapters/remotive.js";
import { buildTestCtx } from "../helpers/ctx.js";

// Stub global fetch to throw — any adapter bypassing ctx.fetch will fail
vi.stubGlobal("fetch", () => {
  throw new Error("Global fetch must not be called in tests — use ctx.fetch");
});

const API_URL = "https://remotive.com/api/remote-jobs?category=software-dev";

// ---------------------------------------------------------------------------
// Inline fixtures
// ---------------------------------------------------------------------------

const salariedJob = {
  id: 1980000,
  url: "https://remotive.com/remote-jobs/software-dev/senior-react-native-engineer-1980000",
  title: "Senior React Native Engineer",
  company_name: "Orbit Labs",
  category: "Software Development",
  tags: ["react native", "typescript"],
  job_type: "full_time",
  publication_date: "2026-07-31T08:00:00",
  candidate_required_location: "USA Only",
  salary: "$140,000 - $170,000",
  description: "<p>Ship mobile features with Expo.</p>",
};

const noSalaryJob = {
  id: 1980001,
  url: "https://remotive.com/remote-jobs/software-dev/frontend-developer-1980001",
  title: "Frontend Developer",
  company_name: "Tidepool",
  category: "Software Development",
  tags: ["react"],
  job_type: "full_time",
  publication_date: "2026-07-30T10:30:00",
  candidate_required_location: "Worldwide",
  salary: "",
  description: "<p>React and friends.</p>",
};

const apiFixture = { jobs: [salariedJob, noSalaryJob], "job-count": 2 };

// ---------------------------------------------------------------------------
// Scenario 1: happy path — field mapping
// ---------------------------------------------------------------------------

describe("Scenario 1: Remotive jobs map to RawJobs", () => {
  it("returns one RawJob per fixture job with correct field mapping", async () => {
    const ctx = buildTestCtx({
      fixtures: {
        [API_URL]: new Response(JSON.stringify(apiFixture), { status: 200 }),
      },
    });

    const jobs = await remotiveAdapter.fetchJobs(ctx);

    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.source === "remotive")).toBe(true);
    expect(ctx.recordedErrors).toHaveLength(0);

    const job = jobs.find((j) => j.externalId === "1980000");
    expect(job).toBeDefined();
    expect(job!.url).toBe(salariedJob.url);
    expect(job!.title).toBe("Senior React Native Engineer");
    expect(job!.company).toBe("Orbit Labs");
    expect(job!.location).toBe("USA Only");
    expect(job!.salaryRaw).toBe("$140,000 - $170,000");
    expect(job!.description).toBe(salariedJob.description);
    expect(job!.postedAt).toBe("2026-07-31T08:00:00");
    expect(job!.raw).toEqual(salariedJob);
  });

  it("omits salaryRaw when the salary string is empty", async () => {
    const ctx = buildTestCtx({
      fixtures: {
        [API_URL]: new Response(JSON.stringify(apiFixture), { status: 200 }),
      },
    });

    const jobs = await remotiveAdapter.fetchJobs(ctx);
    const job = jobs.find((j) => j.externalId === "1980001");

    expect(job).toBeDefined();
    expect(job!.salaryRaw).toBeUndefined();
    expect(job!.location).toBe("Worldwide");
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: failure path — recordError, [] returned, nothing thrown
// ---------------------------------------------------------------------------

describe("Scenario 2: failure paths record errors and return []", () => {
  it("non-200 response → recordError called, [] returned", async () => {
    const ctx = buildTestCtx({
      fixtures: {
        [API_URL]: new Response("server error", { status: 503 }),
      },
    });

    await expect(remotiveAdapter.fetchJobs(ctx)).resolves.toEqual([]);
    expect(ctx.recordedErrors).toHaveLength(1);
    expect(ctx.recordedErrors[0]).toContain("remotive");
    expect(ctx.recordedErrors[0]).toContain("503");
  });

  it("malformed JSON → recordError called, [] returned", async () => {
    const ctx = buildTestCtx({
      fixtures: {
        [API_URL]: new Response("<html>not json</html>", { status: 200 }),
      },
    });

    await expect(remotiveAdapter.fetchJobs(ctx)).resolves.toEqual([]);
    expect(ctx.recordedErrors).toHaveLength(1);
    expect(ctx.recordedErrors[0]).toContain("remotive");
  });
});
