/**
 * Tests for the RemoteOK adapter.
 *
 * Scenarios covered:
 *  1. Happy path: jobs map to RawJobs; the legal-notice element is skipped
 *  2. Salary handling: "0" strings → salaryRaw undefined; real values → "min-max USD"
 *  3. Non-200 response → recordError called, [] returned, no throw
 *
 * All tests run fully offline: ctx.fetch is stubbed from inline fixtures.
 */

import { describe, it, expect, vi } from "vitest";
import { remoteokAdapter } from "../../src/adapters/remoteok.js";
import { buildTestCtx } from "../helpers/ctx.js";

// Stub global fetch to throw — any adapter bypassing ctx.fetch will fail
vi.stubGlobal("fetch", () => {
  throw new Error("Global fetch must not be called in tests — use ctx.fetch");
});

const API_URL = "https://remoteok.com/api";
const TAG_URLS = ["react-native", "mobile", "ios", "android", "flutter"].map(
  (t) => `${API_URL}?tag=${t}`,
);

/** Fixtures for the base feed plus empty (legal-notice-only) tag feeds. */
function allUrlFixtures(base: Response, overrides: Record<string, Response> = {}) {
  const fixtures: Record<string, Response> = { [API_URL]: base };
  for (const url of TAG_URLS) {
    fixtures[url] =
      overrides[url] ??
      new Response(JSON.stringify([{ legal: "notice" }]), { status: 200 });
  }
  return fixtures;
}

// ---------------------------------------------------------------------------
// Inline fixtures
// ---------------------------------------------------------------------------

const legalNotice = {
  "0": "This API is provided for personal use.",
  legal: "By using this API you agree to link back to the job post.",
};

const rnJob = {
  id: "1090000",
  position: "Senior React Native Developer",
  company: "Nomad Apps",
  tags: ["react native", "mobile", "typescript"],
  location: "United States",
  description: "<p>Build our mobile app with Expo.</p>",
  url: "https://remoteok.com/remote-jobs/1090000-senior-react-native-developer",
  apply_url: "https://nomadapps.example/apply",
  date: "2026-07-30T12:00:00+00:00",
  salary_min: "120000",
  salary_max: "160000",
};

const noSalaryJob = {
  id: "1090001",
  position: "Frontend Engineer",
  company: "Beach Co",
  tags: ["react"],
  location: "",
  description: "<p>React work.</p>",
  url: "https://remoteok.com/remote-jobs/1090001-frontend-engineer",
  apply_url: "https://beachco.example/apply",
  date: "2026-07-29T09:00:00+00:00",
  salary_min: "0",
  salary_max: "0",
};

const apiFixture = [legalNotice, rnJob, noSalaryJob];

// ---------------------------------------------------------------------------
// Scenario 1: happy path — legal notice skipped, fields mapped
// ---------------------------------------------------------------------------

describe("Scenario 1: RemoteOK jobs map to RawJobs, legal notice skipped", () => {
  it("skips the legal-notice element and maps every real job", async () => {
    const ctx = buildTestCtx({
      fixtures: allUrlFixtures(
        new Response(JSON.stringify(apiFixture), { status: 200 }),
      ),
    });

    const jobs = await remoteokAdapter.fetchJobs(ctx);

    // Legal notice skipped: 2 jobs, not 3
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.source === "remoteok")).toBe(true);
    expect(ctx.recordedErrors).toHaveLength(0);
  });

  it("maps all fields on the salaried job", async () => {
    const ctx = buildTestCtx({
      fixtures: allUrlFixtures(
        new Response(JSON.stringify(apiFixture), { status: 200 }),
      ),
    });

    const jobs = await remoteokAdapter.fetchJobs(ctx);
    const job = jobs.find((j) => j.externalId === "1090000");

    expect(job).toBeDefined();
    expect(job!.title).toBe("Senior React Native Developer");
    expect(job!.company).toBe("Nomad Apps");
    expect(job!.location).toBe("United States");
    expect(job!.url).toBe(rnJob.url);
    expect(job!.applyUrl).toBe(rnJob.apply_url);
    expect(job!.description).toBe(rnJob.description);
    expect(job!.postedAt).toBe(rnJob.date);
    expect(job!.salaryRaw).toBe("120000-160000 USD");
    expect(job!.raw).toEqual(rnJob);
  });

  it('omits salaryRaw and location when salary strings are "0" and location is empty', async () => {
    const ctx = buildTestCtx({
      fixtures: allUrlFixtures(
        new Response(JSON.stringify(apiFixture), { status: 200 }),
      ),
    });

    const jobs = await remoteokAdapter.fetchJobs(ctx);
    const job = jobs.find((j) => j.externalId === "1090001");

    expect(job).toBeDefined();
    expect(job!.salaryRaw).toBeUndefined();
    expect(job!.location).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: failure path — recordError, [] returned, nothing thrown
// ---------------------------------------------------------------------------

describe("Scenario 2: failure paths record errors and return []", () => {
  it("non-200 response → recordError called, [] returned", async () => {
    const ctx = buildTestCtx({
      fixtures: allUrlFixtures(new Response("rate limited", { status: 429 })),
    });

    await expect(remoteokAdapter.fetchJobs(ctx)).resolves.toEqual([]);
    expect(ctx.recordedErrors).toHaveLength(1);
    expect(ctx.recordedErrors[0]).toContain("remoteok");
    expect(ctx.recordedErrors[0]).toContain("429");
  });

  it("non-array response → recordError called, [] returned", async () => {
    const ctx = buildTestCtx({
      fixtures: allUrlFixtures(
        new Response(JSON.stringify({ error: "nope" }), { status: 200 }),
      ),
    });

    await expect(remoteokAdapter.fetchJobs(ctx)).resolves.toEqual([]);
    expect(ctx.recordedErrors).toHaveLength(1);
    expect(ctx.recordedErrors[0]).toContain("remoteok");
  });
});
