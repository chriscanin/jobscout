/**
 * Tests for the Recruitee adapter.
 *
 * Scenarios covered:
 *  1. Offers listing parses to correctly mapped RawJobs (happy path),
 *     including published_at → ISO conversion
 *  2. remote: true with blank location → "Remote"; bad published_at → undefined
 *  3. 404 company slug skips that company, others still processed
 *  4. Empty offers list is fine (no error)
 */

import { describe, it, expect } from "vitest";
import { recruiteeAdapter } from "../../src/adapters/recruitee.js";
import { buildTestCtx } from "../helpers/ctx.js";
import type { Company } from "@jobscout/core";

// ---------------------------------------------------------------------------
// Company row helpers
// ---------------------------------------------------------------------------

function acmeCompany(): Company {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Acme Corp",
    ats: "recruitee",
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
    ats: "recruitee",
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

const rnOffer = {
  id: 5001,
  slug: "react-native-engineer",
  title: "React Native Engineer",
  description: "<p>Build mobile apps at Acme.</p>",
  requirements: "<p>5 years of React Native.</p>",
  careers_url: "https://acme.recruitee.com/o/react-native-engineer",
  careers_apply_url: "https://acme.recruitee.com/o/react-native-engineer/c/new",
  company_name: "Acme (Recruitee)",
  location: "Berlin, Germany",
  remote: false,
  published_at: "2026-07-28 07:42:48 UTC",
};

const remoteOffer = {
  id: 5002,
  slug: "frontend-engineer",
  title: "Frontend Engineer",
  description: "<p>Fully remote frontend role.</p>",
  requirements: "",
  careers_url: "https://acme.recruitee.com/o/frontend-engineer",
  careers_apply_url: "https://acme.recruitee.com/o/frontend-engineer/c/new",
  company_name: "Acme (Recruitee)",
  location: "",
  remote: true,
  published_at: "not a real timestamp",
};

const offersFixture = { offers: [rnOffer, remoteOffer] };

const LIST_URL = "https://acme.recruitee.com/api/offers/";
const BAD_LIST_URL = "https://bad-token.recruitee.com/api/offers/";

// ---------------------------------------------------------------------------
// Scenario 1: offers listing parses to correctly mapped RawJobs
// ---------------------------------------------------------------------------

describe("Scenario 1: Recruitee offers parse to correctly mapped RawJobs", () => {
  it("returns one RawJob per offer with correct field mapping and ISO postedAt", async () => {
    const ctx = buildTestCtx({
      companies: [acmeCompany()],
      fixtures: {
        [LIST_URL]: new Response(JSON.stringify(offersFixture), { status: 200 }),
      },
    });

    const jobs = await recruiteeAdapter.fetchJobs(ctx);

    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job.source).toBe("recruitee");
      expect(job.atsHint).toBe("recruitee");
      // company comes from the companies row, NOT the API's company_name
      expect(job.company).toBe("Acme Corp");
    }

    const first = jobs.find((j) => j.externalId === "5001")!;
    expect(first).toBeDefined();
    expect(first.title).toBe("React Native Engineer");
    expect(first.url).toBe("https://acme.recruitee.com/o/react-native-engineer");
    expect(first.applyUrl).toBe(
      "https://acme.recruitee.com/o/react-native-engineer/c/new",
    );
    expect(first.location).toBe("Berlin, Germany");
    // description + "\n\n" + requirements
    expect(first.description).toBe(
      "<p>Build mobile apps at Acme.</p>\n\n<p>5 years of React Native.</p>",
    );
    // "2026-07-28 07:42:48 UTC" → "2026-07-28T07:42:48Z"
    expect(first.postedAt).toBe("2026-07-28T07:42:48Z");
    expect(first.raw).toMatchObject({ slug: "react-native-engineer" });
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: remote blank location → "Remote"; bad published_at → undefined
// ---------------------------------------------------------------------------

describe("Scenario 2: remote offer with blank location and bad published_at", () => {
  it("maps location to \"Remote\" and postedAt to undefined", async () => {
    const ctx = buildTestCtx({
      companies: [acmeCompany()],
      fixtures: {
        [LIST_URL]: new Response(JSON.stringify(offersFixture), { status: 200 }),
      },
    });

    const jobs = await recruiteeAdapter.fetchJobs(ctx);

    const remote = jobs.find((j) => j.externalId === "5002")!;
    expect(remote).toBeDefined();
    expect(remote.location).toBe("Remote");
    expect(remote.postedAt).toBeUndefined();
    // Empty requirements → description alone, no separator appended.
    expect(remote.description).toBe("<p>Fully remote frontend role.</p>");
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: 404 company slug skips that company, others still processed
// ---------------------------------------------------------------------------

describe("Scenario 3: 404 company slug skips that company, others still processed", () => {
  it("records an error for bad-token and still returns Acme jobs", async () => {
    const ctx = buildTestCtx({
      companies: [badTokenCompany(), acmeCompany()],
      fixtures: {
        // bad-token listing is missing from the fixture map → 404
        [LIST_URL]: new Response(JSON.stringify(offersFixture), { status: 200 }),
      },
    });

    const jobs = await recruiteeAdapter.fetchJobs(ctx);

    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.company === "Acme Corp")).toBe(true);

    expect(ctx.recordedErrors).toHaveLength(1);
    expect(ctx.recordedErrors[0]).toContain("bad-token");
    expect(ctx.recordedErrors[0]).toContain("404");

    // bad-token listing + acme listing
    expect(ctx.fetchCallCount()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: empty offers list is fine
// ---------------------------------------------------------------------------

describe("Scenario 4: empty offers list is fine", () => {
  it("returns no jobs and records no errors", async () => {
    const ctx = buildTestCtx({
      companies: [acmeCompany()],
      fixtures: {
        [LIST_URL]: new Response(JSON.stringify({ offers: [] }), { status: 200 }),
      },
    });

    const jobs = await recruiteeAdapter.fetchJobs(ctx);

    expect(jobs).toHaveLength(0);
    expect(ctx.recordedErrors).toHaveLength(0);
  });
});
