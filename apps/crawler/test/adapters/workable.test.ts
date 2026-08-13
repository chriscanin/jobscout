/**
 * Tests for the Workable adapter.
 *
 * Scenarios covered:
 *  1. Widget listing parses to correctly mapped RawJobs (happy path)
 *  2. telecommuting: true with no city/state/country → location "Remote"
 *  3. 404 account slug skips that company, others still processed
 */

import { describe, it, expect } from "vitest";
import { workableAdapter } from "../../src/adapters/workable.js";
import { buildTestCtx } from "../helpers/ctx.js";
import type { Company } from "@jobscout/core";

// ---------------------------------------------------------------------------
// Company row helpers
// ---------------------------------------------------------------------------

function acmeCompany(): Company {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Acme Corp",
    ats: "workable",
    board_token: "acme",
    careers_url: null,
    discovered_via: "seed",
    active: true,
    last_crawled_at: null,
    created_at: null,
  };
}

function badTokenCompany(): Company {
  return {
    id: "00000000-0000-0000-0000-000000000002",
    name: "Bad Token Co",
    ats: "workable",
    board_token: "bad-token",
    careers_url: null,
    discovered_via: "seed",
    active: true,
    last_crawled_at: null,
    created_at: null,
  };
}

// ---------------------------------------------------------------------------
// Inline fixtures
// ---------------------------------------------------------------------------

const rnJob = {
  title: "React Native Engineer",
  shortcode: "AB12CD",
  url: "https://apply.workable.com/j/AB12CD",
  application_url: "https://apply.workable.com/j/AB12CD/apply",
  published_on: "2026-07-15",
  city: "Austin",
  state: "Texas",
  country: "United States",
  telecommuting: false,
  description: "<p>Build mobile apps at Acme.</p>",
};

const remoteJob = {
  title: "Frontend Engineer",
  shortcode: "EF34GH",
  url: "https://apply.workable.com/j/EF34GH",
  application_url: "https://apply.workable.com/j/EF34GH/apply",
  published_on: "2026-07-20",
  city: "",
  state: "",
  country: "",
  telecommuting: true,
  description: "<p>Fully remote frontend role.</p>",
};

// The API's own account name deliberately differs from the companies row name.
const widgetFixture = { name: "Acme (Workable)", jobs: [rnJob, remoteJob] };

const LIST_URL =
  "https://apply.workable.com/api/v1/widget/accounts/acme?details=true";
const BAD_LIST_URL =
  "https://apply.workable.com/api/v1/widget/accounts/bad-token?details=true";

// ---------------------------------------------------------------------------
// Scenario 1: widget listing parses to correctly mapped RawJobs
// ---------------------------------------------------------------------------

describe("Scenario 1: Workable widget listing parses to correctly mapped RawJobs", () => {
  it("returns one RawJob per fixture job with correct field mapping", async () => {
    const ctx = buildTestCtx({
      companies: [acmeCompany()],
      fixtures: {
        [LIST_URL]: new Response(JSON.stringify(widgetFixture), { status: 200 }),
      },
    });

    const jobs = await workableAdapter.fetchJobs(ctx);

    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job.source).toBe("workable");
      expect(job.atsHint).toBe("workable");
      // company comes from the companies row, NOT the API's account name
      expect(job.company).toBe("Acme Corp");
    }

    const first = jobs.find((j) => j.externalId === "AB12CD")!;
    expect(first).toBeDefined();
    expect(first.title).toBe("React Native Engineer");
    expect(first.url).toBe("https://apply.workable.com/j/AB12CD");
    expect(first.applyUrl).toBe("https://apply.workable.com/j/AB12CD/apply");
    expect(first.location).toBe("Austin, Texas, United States");
    expect(first.postedAt).toBe("2026-07-15");
    expect(first.description).toBe("<p>Build mobile apps at Acme.</p>");
    expect(first.raw).toMatchObject({ shortcode: "AB12CD" });

    // Single listing call — details=true means no per-job fetches.
    expect(ctx.fetchCallCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: telecommuting with empty location → "Remote"
// ---------------------------------------------------------------------------

describe("Scenario 2: telecommuting with empty location maps to \"Remote\"", () => {
  it("sets location to \"Remote\" when telecommuting is true and city/state/country are empty", async () => {
    const ctx = buildTestCtx({
      companies: [acmeCompany()],
      fixtures: {
        [LIST_URL]: new Response(JSON.stringify(widgetFixture), { status: 200 }),
      },
    });

    const jobs = await workableAdapter.fetchJobs(ctx);

    const remote = jobs.find((j) => j.externalId === "EF34GH")!;
    expect(remote).toBeDefined();
    expect(remote.location).toBe("Remote");
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: 404 account slug skips that company, others still processed
// ---------------------------------------------------------------------------

describe("Scenario 3: 404 account slug skips that company, others still processed", () => {
  it("records an error for bad-token and still returns Acme jobs", async () => {
    const ctx = buildTestCtx({
      companies: [badTokenCompany(), acmeCompany()],
      fixtures: {
        // bad-token listing is missing from the fixture map → 404
        [LIST_URL]: new Response(JSON.stringify(widgetFixture), { status: 200 }),
      },
    });

    const jobs = await workableAdapter.fetchJobs(ctx);

    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.company === "Acme Corp")).toBe(true);

    expect(ctx.recordedErrors).toHaveLength(1);
    expect(ctx.recordedErrors[0]).toContain("bad-token");
    expect(ctx.recordedErrors[0]).toContain("404");

    // bad-token listing + acme listing
    expect(ctx.fetchCallCount()).toBe(2);
  });
});
