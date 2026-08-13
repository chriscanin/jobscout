/**
 * Tests for the SmartRecruiters adapter.
 *
 * Scenarios covered:
 *  1. Listing + detail parse to correctly mapped RawJobs (happy path)
 *  2. Detail fetched only for prescreen-passing titles; fallback url for others
 *  3. remote: true appends " (Remote)" when fullLocation lacks it
 *  4. Pagination: totalFound 150 → two list calls
 *  5. 404 board token skips that company, others still processed
 */

import { describe, it, expect } from "vitest";
import { smartrecruitersAdapter } from "../../src/adapters/smartrecruiters.js";
import { buildTestCtx } from "../helpers/ctx.js";
import type { Company } from "@jobscout/core";

// ---------------------------------------------------------------------------
// Company row helpers
// ---------------------------------------------------------------------------

function acmeCompany(): Company {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Acme Corp",
    ats: "smartrecruiters",
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
    ats: "smartrecruiters",
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

const rnListItem = {
  id: "90001",
  name: "React Native Engineer",
  releasedDate: "2026-07-01T10:00:00.000Z",
  location: {
    city: "San Francisco",
    region: "CA",
    country: "us",
    remote: false,
    fullLocation: "San Francisco, CA, US",
  },
  ref: "https://api.smartrecruiters.com/v1/companies/acme/postings/90001",
};

const accountantListItem = {
  id: "90002",
  name: "Accountant",
  releasedDate: "2026-06-20T08:30:00.000Z",
  location: {
    city: "New York",
    region: "NY",
    country: "us",
    remote: false,
    fullLocation: "New York, NY, US",
  },
  ref: "https://api.smartrecruiters.com/v1/companies/acme/postings/90002",
};

const remoteListItem = {
  id: "90003",
  name: "Payroll Specialist",
  releasedDate: "2026-06-25T09:00:00.000Z",
  location: {
    city: "Denver",
    region: "CO",
    country: "us",
    remote: true,
    fullLocation: "Denver, CO, US",
  },
  ref: "https://api.smartrecruiters.com/v1/companies/acme/postings/90003",
};

const rnDetail = {
  ...rnListItem,
  postingUrl: "https://jobs.smartrecruiters.com/AcmeCorp/90001-react-native-engineer",
  applyUrl:
    "https://jobs.smartrecruiters.com/AcmeCorp/90001-react-native-engineer?oga=true",
  jobAd: {
    sections: {
      companyDescription: { title: "Company Description", text: "About Acme." },
      jobDescription: { title: "Job Description", text: "Build mobile apps." },
      qualifications: { title: "Qualifications", text: "5 years React Native." },
      additionalInformation: { title: "Additional Information", text: "Great perks." },
    },
  },
};

function listResponse(content: Record<string, unknown>[], totalFound: number, offset = 0) {
  return new Response(
    JSON.stringify({ offset, limit: 100, totalFound, content }),
    { status: 200 },
  );
}

const LIST_URL =
  "https://api.smartrecruiters.com/v1/companies/acme/postings?limit=100&offset=0";
const LIST_URL_PAGE_2 =
  "https://api.smartrecruiters.com/v1/companies/acme/postings?limit=100&offset=100";
const DETAIL_URL =
  "https://api.smartrecruiters.com/v1/companies/acme/postings/90001";
const BAD_LIST_URL =
  "https://api.smartrecruiters.com/v1/companies/bad-token/postings?limit=100&offset=0";

// ---------------------------------------------------------------------------
// Scenario 1: listing + detail parse to correctly mapped RawJobs
// ---------------------------------------------------------------------------

describe("Scenario 1: SmartRecruiters listing + detail parse to correctly mapped RawJobs", () => {
  it("maps the prescreen-passing job with detail fields merged in", async () => {
    const ctx = buildTestCtx({
      companies: [acmeCompany()],
      fixtures: {
        [LIST_URL]: listResponse([rnListItem, accountantListItem], 2),
        [DETAIL_URL]: new Response(JSON.stringify(rnDetail), { status: 200 }),
      },
    });

    const jobs = await smartrecruitersAdapter.fetchJobs(ctx);

    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job.source).toBe("smartrecruiters");
      expect(job.atsHint).toBe("smartrecruiters");
      // company comes from the companies row, NOT the API
      expect(job.company).toBe("Acme Corp");
    }

    const rnJob = jobs.find((j) => j.externalId === "90001")!;
    expect(rnJob).toBeDefined();
    expect(rnJob.title).toBe("React Native Engineer");
    expect(rnJob.url).toBe(rnDetail.postingUrl);
    expect(rnJob.applyUrl).toBe(rnDetail.applyUrl);
    expect(rnJob.location).toBe("San Francisco, CA, US");
    expect(rnJob.postedAt).toBe("2026-07-01T10:00:00.000Z");
    expect(rnJob.description).toBe(
      "About Acme.\n\nBuild mobile apps.\n\n5 years React Native.\n\nGreat perks.",
    );
    expect(rnJob.raw).toMatchObject({ postingUrl: rnDetail.postingUrl });
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: detail fetched only for prescreen-passing titles
// ---------------------------------------------------------------------------

describe("Scenario 2: detail fetched only for prescreen-passing titles", () => {
  it("fetches detail for the React Native job but not the Accountant", async () => {
    const ctx = buildTestCtx({
      companies: [acmeCompany()],
      fixtures: {
        [LIST_URL]: listResponse([rnListItem, accountantListItem], 2),
        [DETAIL_URL]: new Response(JSON.stringify(rnDetail), { status: 200 }),
      },
    });

    const jobs = await smartrecruitersAdapter.fetchJobs(ctx);

    // 1 listing call + 1 detail call (for the RN job only)
    expect(ctx.fetchCallCount()).toBe(2);

    // The Accountant job is still returned, with the fallback url and no detail fields.
    const accountant = jobs.find((j) => j.externalId === "90002")!;
    expect(accountant).toBeDefined();
    expect(accountant.url).toBe("https://jobs.smartrecruiters.com/acme/90002");
    expect(accountant.applyUrl).toBeUndefined();
    expect(accountant.description).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: remote: true appends " (Remote)" when fullLocation lacks it
// ---------------------------------------------------------------------------

describe("Scenario 3: remote location handling", () => {
  it("appends \" (Remote)\" to fullLocation when location.remote is true", async () => {
    const ctx = buildTestCtx({
      companies: [acmeCompany()],
      fixtures: {
        [LIST_URL]: listResponse([remoteListItem], 1),
      },
    });

    const jobs = await smartrecruitersAdapter.fetchJobs(ctx);

    expect(jobs).toHaveLength(1);
    expect(jobs[0].location).toBe("Denver, CO, US (Remote)");
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: pagination — totalFound 150 → two list calls
// ---------------------------------------------------------------------------

describe("Scenario 4: pagination collects all pages up to totalFound", () => {
  it("makes two list calls for totalFound 150 and returns 150 jobs", async () => {
    // Non-matching titles so no detail fetches muddy the call count.
    const makeItem = (i: number) => ({
      id: String(80000 + i),
      name: `Accountant ${i}`,
      releasedDate: "2026-06-01T00:00:00.000Z",
      location: {
        city: "Austin",
        region: "TX",
        country: "us",
        remote: false,
        fullLocation: "Austin, TX, US",
      },
      ref: `https://api.smartrecruiters.com/v1/companies/acme/postings/${80000 + i}`,
    });
    const items = Array.from({ length: 150 }, (_, i) => makeItem(i));

    const ctx = buildTestCtx({
      companies: [acmeCompany()],
      fixtures: {
        [LIST_URL]: listResponse(items.slice(0, 100), 150, 0),
        [LIST_URL_PAGE_2]: listResponse(items.slice(100), 150, 100),
      },
    });

    const jobs = await smartrecruitersAdapter.fetchJobs(ctx);

    expect(jobs).toHaveLength(150);
    // Exactly two list calls, no detail calls.
    expect(ctx.fetchCallCount()).toBe(2);
    expect(jobs[0].externalId).toBe("80000");
    expect(jobs[149].externalId).toBe("80149");
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: 404 board token skips that company, others still processed
// ---------------------------------------------------------------------------

describe("Scenario 5: 404 board token skips that company, others still processed", () => {
  it("records an error for bad-token and still returns Acme jobs", async () => {
    const ctx = buildTestCtx({
      companies: [badTokenCompany(), acmeCompany()],
      fixtures: {
        // bad-token listing is missing from the fixture map → 404
        [LIST_URL]: listResponse([accountantListItem], 1),
      },
    });

    const jobs = await smartrecruitersAdapter.fetchJobs(ctx);

    expect(jobs).toHaveLength(1);
    expect(jobs.every((j) => j.company === "Acme Corp")).toBe(true);

    expect(ctx.recordedErrors).toHaveLength(1);
    expect(ctx.recordedErrors[0]).toContain("bad-token");
    expect(ctx.recordedErrors[0]).toContain("404");

    // bad-token listing + acme listing only (no retry pages after the 404)
    expect(ctx.fetchCallCount()).toBe(2);
  });
});
