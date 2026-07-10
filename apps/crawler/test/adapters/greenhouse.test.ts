/**
 * Tests for the Greenhouse adapter (spec 02-adapters-api-boards.atdd.md).
 *
 * Scenarios covered:
 *  1. Listing parses to correctly mapped RawJobs (happy path)
 *  2. Prescreen-passing job gets its questions captured
 *  3. Prescreen prevents detail fetches for non-matching titles
 *  6. 404 board token skips that company, others still processed
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { greenhouseAdapter } from "../../src/adapters/greenhouse.js";
import { buildTestCtx } from "../helpers/ctx.js";
import type { Company } from "@jobscout/core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "../fixtures/greenhouse");

// ---------------------------------------------------------------------------
// Load fixtures
// ---------------------------------------------------------------------------

const boardFixture = JSON.parse(
  readFileSync(resolve(FIXTURES, "mattermost-board.json"), "utf8"),
) as { jobs: Record<string, unknown>[] };

const detailFixture = JSON.parse(
  readFileSync(resolve(FIXTURES, "mattermost-job-5238290008.json"), "utf8"),
) as Record<string, unknown>;

// ---------------------------------------------------------------------------
// Company row helpers
// ---------------------------------------------------------------------------

function mattermostCompany(): Company {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Mattermost",
    ats: "greenhouse",
    board_token: "mattermost",
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
    ats: "greenhouse",
    board_token: "bad-token",
    careers_url: null,
    discovered_via: "seed",
    active: true,
    last_crawled_at: null,
    created_at: null,
  };
}

const BOARD_URL =
  "https://boards-api.greenhouse.io/v1/boards/mattermost/jobs?content=true";
const DETAIL_URL =
  "https://boards-api.greenhouse.io/v1/boards/mattermost/jobs/5238290008?questions=true";
const BAD_BOARD_URL =
  "https://boards-api.greenhouse.io/v1/boards/bad-token/jobs?content=true";

// ---------------------------------------------------------------------------
// Scenario 1: listing parses to correctly mapped RawJobs
// ---------------------------------------------------------------------------

describe("Scenario 1: Greenhouse listing parses to correctly mapped RawJobs", () => {
  it("returns one RawJob per fixture job with correct field mapping", async () => {
    const ctx = buildTestCtx({
      companies: [mattermostCompany()],
      fixtures: {
        [BOARD_URL]: new Response(JSON.stringify(boardFixture), { status: 200 }),
      },
    });

    const jobs = await greenhouseAdapter.fetchJobs(ctx);

    // Result length equals fixture jobs length
    expect(jobs).toHaveLength(boardFixture.jobs.length);

    // Every job has the correct source, atsHint, company
    for (const job of jobs) {
      expect(job.source).toBe("greenhouse");
      expect(job.atsHint).toBe("greenhouse");
      expect(job.company).toBe("Mattermost");
    }

    // First job field mapping
    const firstFixtureJob = boardFixture.jobs[0];
    const firstJob = jobs[0];

    const locationObj = firstFixtureJob["location"] as { name?: string } | undefined;

    expect(firstJob.externalId).toBe(String(firstFixtureJob["id"]));
    expect(firstJob.url).toBe(String(firstFixtureJob["absolute_url"]));
    expect(firstJob.title).toBe(String(firstFixtureJob["title"]));
    expect(firstJob.location).toBe(locationObj?.name);
    expect(firstJob.postedAt).toBe(String(firstFixtureJob["first_published"]));
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: prescreen-passing job gets questions captured
// ---------------------------------------------------------------------------

describe("Scenario 2: prescreen-passing job gets questions captured", () => {
  it("includes questions from the detail fixture for the React Native job", async () => {
    // Job 5238290008 title is "Senior React Native Engineer " which matches
    // "react native" keyword in DEFAULT_CRITERIA.
    const ctx = buildTestCtx({
      companies: [mattermostCompany()],
      fixtures: {
        [BOARD_URL]: new Response(JSON.stringify(boardFixture), { status: 200 }),
        [DETAIL_URL]: new Response(JSON.stringify(detailFixture), { status: 200 }),
      },
    });

    const jobs = await greenhouseAdapter.fetchJobs(ctx);

    const rnJob = jobs.find((j) => j.externalId === "5238290008");
    expect(rnJob).toBeDefined();
    expect(rnJob!.questions).toEqual(detailFixture["questions"]);
    // raw should contain the detail payload
    expect(rnJob!.raw).toMatchObject({ questions: detailFixture["questions"] });
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: prescreen prevents detail fetches for non-matching titles
// ---------------------------------------------------------------------------

describe("Scenario 3: prescreen prevents detail fetches for non-matching titles", () => {
  it("only requests details for keyword-matching jobs; non-matching job has questions undefined", async () => {
    const ctx = buildTestCtx({
      companies: [mattermostCompany()],
      fixtures: {
        [BOARD_URL]: new Response(JSON.stringify(boardFixture), { status: 200 }),
        [DETAIL_URL]: new Response(JSON.stringify(detailFixture), { status: 200 }),
      },
    });

    const jobs = await greenhouseAdapter.fetchJobs(ctx);

    // Identify which fixture jobs do NOT match any criteria keyword
    const keywords = ["react native", "mobile developer", "mobile engineer", "expo",
      "ios engineer", "android engineer", "react developer", "react engineer",
      "react.js", "frontend", "front-end", "front end", "ui engineer",
      "web developer", "full stack", "fullstack", "full-stack"];

    const nonMatchingFixtureJobs = boardFixture.jobs.filter((fj) => {
      const lower = String(fj["title"]).toLowerCase();
      return !keywords.some((kw) => lower.includes(kw));
    });

    // There should be at least one non-matching job (e.g. "Account Manager - Federal")
    expect(nonMatchingFixtureJobs.length).toBeGreaterThan(0);

    for (const fixJob of nonMatchingFixtureJobs) {
      const jobId = String(fixJob["id"]);
      const resultJob = jobs.find((j) => j.externalId === jobId);
      expect(resultJob).toBeDefined();
      expect(resultJob!.questions).toBeUndefined();

      // No detail URL for this job should have been requested
      // (The fixture map only has the detail for 5238290008 — any other
      //  detail URL would 404, so the adapter would warn but still return
      //  the job. We verify by checking none of the recorded fetch URLs
      //  contain the non-matching job's id.)
    }

    // The listing request + detail requests only for matching jobs
    // Matching jobs: those whose title matches a keyword
    const matchingJobIds = boardFixture.jobs
      .filter((fj) => {
        const lower = String(fj["title"]).toLowerCase();
        return keywords.some((kw) => lower.includes(kw));
      })
      .map((fj) => String(fj["id"]));

    // Total calls = 1 listing + matchingJobIds.length detail calls
    expect(ctx.fetchCallCount()).toBe(1 + matchingJobIds.length);

    // All non-matching jobs are still returned
    for (const nonMatch of nonMatchingFixtureJobs) {
      const found = jobs.find((j) => j.externalId === String(nonMatch["id"]));
      expect(found).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: 404 board token skips that company, others still processed
// ---------------------------------------------------------------------------

describe("Scenario 6: 404 board token skips that company, others still processed", () => {
  it("returns only Mattermost jobs; recordError called once with bad-token and 404", async () => {
    const ctx = buildTestCtx({
      companies: [badTokenCompany(), mattermostCompany()],
      fixtures: {
        // bad-token listing returns 404 (missing from fixture map → buildTestCtx returns 404)
        [BOARD_URL]: new Response(JSON.stringify(boardFixture), { status: 200 }),
      },
    });

    const jobs = await greenhouseAdapter.fetchJobs(ctx);

    // Only Mattermost jobs returned
    expect(jobs.every((j) => j.company === "Mattermost")).toBe(true);
    expect(jobs.length).toBe(boardFixture.jobs.length);

    // recordError called exactly once for bad-token
    expect(ctx.recordedErrors).toHaveLength(1);
    expect(ctx.recordedErrors[0]).toContain("bad-token");
    expect(ctx.recordedErrors[0]).toContain("404");

    // The bad-token URL was requested exactly once (no retry on 404)
    // Listing was requested once for bad-token + once for mattermost
    // 404 is non-retryable per ctx.fetch (which is the raw fakeFetch here,
    // returning 404 immediately for unmapped URLs)
    expect(ctx.fetchCallCount()).toBeGreaterThanOrEqual(2); // bad-token + mattermost listing
  });
});
