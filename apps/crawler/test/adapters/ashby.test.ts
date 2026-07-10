/**
 * Tests for the Ashby adapter (spec 02-adapters-api-boards.atdd.md).
 *
 * Scenarios covered:
 *  5. Ashby job board parses to correctly mapped RawJobs (happy path)
 *  8. Malformed JSON from one company does not abort the others (error case)
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { ashbyAdapter } from "../../src/adapters/ashby.js";
import { buildTestCtx } from "../helpers/ctx.js";
import type { Company } from "@jobscout/core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "../fixtures/ashby");

// ---------------------------------------------------------------------------
// Load fixtures
// ---------------------------------------------------------------------------

const boardFixture = JSON.parse(
  readFileSync(resolve(FIXTURES, "job-board.json"), "utf8"),
) as { jobs: Record<string, unknown>[]; apiVersion: string };

// ---------------------------------------------------------------------------
// Company row helpers
// ---------------------------------------------------------------------------

function rampCompany(): Company {
  return {
    id: "00000000-0000-0000-0000-000000000020",
    name: "Ramp",
    ats: "ashby",
    board_token: "ramp",
    careers_url: null,
    discovered_via: "seed",
    active: true,
    last_crawled_at: null,
    created_at: null,
  };
}

function companyA(): Company {
  return {
    id: "00000000-0000-0000-0000-000000000021",
    name: "Company A",
    ats: "ashby",
    board_token: "company-a",
    careers_url: null,
    discovered_via: "seed",
    active: true,
    last_crawled_at: null,
    created_at: null,
  };
}

function companyB(): Company {
  return {
    id: "00000000-0000-0000-0000-000000000022",
    name: "Company B",
    ats: "ashby",
    board_token: "company-b",
    careers_url: null,
    discovered_via: "seed",
    active: true,
    last_crawled_at: null,
    created_at: null,
  };
}

const RAMP_URL = "https://api.ashbyhq.com/posting-api/job-board/ramp";
const COMPANY_A_URL = "https://api.ashbyhq.com/posting-api/job-board/company-a";
const COMPANY_B_URL = "https://api.ashbyhq.com/posting-api/job-board/company-b";

// ---------------------------------------------------------------------------
// Scenario 5: Ashby job board parses to correctly mapped RawJobs
// ---------------------------------------------------------------------------

describe("Scenario 5: Ashby job board parses to correctly mapped RawJobs", () => {
  it("returns one RawJob per fixture job with correct field mapping", async () => {
    const ctx = buildTestCtx({
      companies: [rampCompany()],
      fixtures: {
        [RAMP_URL]: new Response(JSON.stringify(boardFixture), { status: 200 }),
      },
    });

    const jobs = await ashbyAdapter.fetchJobs(ctx);

    // Result length equals fixture jobs.length
    expect(jobs).toHaveLength(boardFixture.jobs.length);

    // First job field mapping
    const first = boardFixture.jobs[0];
    const firstJob = jobs[0];

    expect(firstJob.externalId).toBe(String(first["id"]));
    expect(firstJob.url).toBe(String(first["jobUrl"]));
    expect(firstJob.title).toBe(String(first["title"]));
    expect(firstJob.location).toBe(String(first["location"]));
    expect(firstJob.postedAt).toBe(String(first["publishedAt"]));
    expect(firstJob.atsHint).toBe("ashby");
    expect(firstJob.questions).toBeUndefined();
    expect(firstJob.company).toBe("Ramp");
  });
});

// ---------------------------------------------------------------------------
// Scenario 8: Malformed JSON from one company does not abort the others
// ---------------------------------------------------------------------------

describe("Scenario 8: Malformed JSON from one company does not abort the others", () => {
  it("isolates company A parse failure and returns company B jobs unaffected", async () => {
    const ctx = buildTestCtx({
      companies: [companyA(), companyB()],
      fixtures: {
        [COMPANY_A_URL]: new Response(
          "<!DOCTYPE html><html>maintenance</html>",
          { status: 200 },
        ),
        [COMPANY_B_URL]: new Response(JSON.stringify(boardFixture), { status: 200 }),
      },
    });

    const jobs = await ashbyAdapter.fetchJobs(ctx);

    // Only company B's jobs are returned
    expect(jobs).toHaveLength(boardFixture.jobs.length);
    expect(jobs.every((j) => j.company === "Company B")).toBe(true);

    // recordError called exactly once with company A's board_token
    expect(ctx.recordedErrors).toHaveLength(1);
    expect(ctx.recordedErrors[0]).toContain("company-a");
  });
});
