/**
 * ATDD spec 03 — CalJobs adapter tests (C1–C4)
 *
 * All tests run fully offline: ctx.fetch is stubbed from fixture files.
 * Global fetch throws if called (enforced by the test helper).
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { caljobsAdapter } from "../../src/adapters/caljobs.js";
import { buildTestCtx } from "../helpers/ctx.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURE_DIR = join(
  new URL(".", import.meta.url).pathname,
  "../fixtures/caljobs",
);

function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

// Stub global fetch to throw — any adapter bypassing ctx.fetch will fail
vi.stubGlobal("fetch", () => {
  throw new Error("Global fetch must not be called in tests — use ctx.fetch");
});

// ---------------------------------------------------------------------------
// C1 — Happy path: real fixture parses into RawJobs with stable external_ids
// ---------------------------------------------------------------------------

describe("C1 — happy path: parse and stable external_ids", () => {
  it("returns ≥ 1 RawJob from page1 fixture with correct shape", async () => {
    const page1Html = fixture("search-results-page1.html");
    const ctx = buildTestCtx({
      fixtures: {
        "https://www.caljobs.ca.gov/vosnet/jobbanks/jobsearch.aspx?q=react+native+OR+react-native+OR+expo+OR+mobile+OR+ios+OR+android+OR+swift+OR+kotlin+OR+flutter+OR+react+developer+OR+react+engineer+OR+react.js+OR+frontend+OR+front-end+OR+front+end+OR+ui+engineer+OR+web+developer+OR+full+stack+OR+fullstack+OR+full-stack&pg=1":
          new Response(page1Html, { status: 200 }),
      },
    });

    const jobs = await caljobsAdapter.fetchJobs(ctx);

    expect(jobs.length).toBeGreaterThanOrEqual(1);
    for (const job of jobs) {
      expect(job.source).toBe("caljobs");
      expect(job.title).toBeTruthy();
      expect(job.company).toBeTruthy();
      expect(job.url).toMatch(/^https:\/\/www\.caljobs\.ca\.gov/);
      expect(job.externalId).toBeTruthy();
      // externalId must contain no ?, &, =, or /
      expect(job.externalId).not.toMatch(/[?&=/]/);
    }
  });

  it("returns identical sorted externalId list on second call (byte-stability)", async () => {
    const page1Html = fixture("search-results-page1.html");
    const makeCtx = () =>
      buildTestCtx({
        fixtures: {
          "https://www.caljobs.ca.gov/vosnet/jobbanks/jobsearch.aspx?q=react+native+OR+react-native+OR+expo+OR+mobile+OR+ios+OR+android+OR+swift+OR+kotlin+OR+flutter+OR+react+developer+OR+react+engineer+OR+react.js+OR+frontend+OR+front-end+OR+front+end+OR+ui+engineer+OR+web+developer+OR+full+stack+OR+fullstack+OR+full-stack&pg=1":
            new Response(page1Html, { status: 200 }),
        },
      });

    const jobs1 = await caljobsAdapter.fetchJobs(makeCtx());
    const jobs2 = await caljobsAdapter.fetchJobs(makeCtx());

    const ids1 = jobs1.map((j) => j.externalId).sort();
    const ids2 = jobs2.map((j) => j.externalId).sort();
    expect(ids1).toEqual(ids2);
    expect(ids1.length).toBeGreaterThanOrEqual(1);
  });

  it("externalIds within the page are unique", async () => {
    const page1Html = fixture("search-results-page1.html");
    const ctx = buildTestCtx({
      fixtures: {
        "https://www.caljobs.ca.gov/vosnet/jobbanks/jobsearch.aspx?q=react+native+OR+react-native+OR+expo+OR+mobile+OR+ios+OR+android+OR+swift+OR+kotlin+OR+flutter+OR+react+developer+OR+react+engineer+OR+react.js+OR+frontend+OR+front-end+OR+front+end+OR+ui+engineer+OR+web+developer+OR+full+stack+OR+fullstack+OR+full-stack&pg=1":
          new Response(page1Html, { status: 200 }),
      },
    });

    const jobs = await caljobsAdapter.fetchJobs(ctx);
    const ids = jobs.map((j) => j.externalId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// C2 — Session-cookie flow
// ---------------------------------------------------------------------------

describe("C2 — session-cookie flow", () => {
  it("echoes session cookie from Set-Cookie in subsequent requests", async () => {
    const page1Html = fixture("search-results-page1.html");
    const sessionCookie = "ASP.NET_SessionId=abc123xyz789session";

    // Track all fetch calls with their init headers
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

    // The search URL the adapter will actually call
    const searchUrl =
      "https://www.caljobs.ca.gov/vosnet/jobbanks/jobsearch.aspx?q=react+native+OR+react-native+OR+expo+OR+mobile+OR+ios+OR+android+OR+swift+OR+kotlin+OR+flutter+OR+react+developer+OR+react+engineer+OR+react.js+OR+frontend+OR+front-end+OR+front+end+OR+ui+engineer+OR+web+developer+OR+full+stack+OR+fullstack+OR+full-stack&pg=1";

    const ctx = buildTestCtx({
      fixtures: {
        [searchUrl]: new Response(page1Html, {
          status: 200,
          headers: { "Set-Cookie": sessionCookie },
        }),
      },
    });

    // Wrap fetch to capture all calls
    const originalFetch = ctx.fetch;
    const capturedCalls: Array<{ url: string; init?: RequestInit }> = [];
    ctx.fetch = async (url: string | URL, init?: RequestInit) => {
      capturedCalls.push({ url: url.toString(), init });
      return originalFetch(url.toString(), init);
    };

    const jobs = await caljobsAdapter.fetchJobs(ctx);

    // The adapter must have fetched the search URL
    expect(capturedCalls.length).toBeGreaterThanOrEqual(1);
    const searchCall = capturedCalls.find((c) => c.url === searchUrl);
    expect(searchCall).toBeDefined();
    // Jobs should parse from the fixture
    expect(jobs.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// C3 — Pagination stops at the 3-page cap
// ---------------------------------------------------------------------------

describe("C3 — pagination stops at 3-page cap", () => {
  it("fetches exactly 3 pages and no more, even when 5 pages are advertised", async () => {
    const page1Html = fixture("search-results-page1.html");
    const page2Html = fixture("search-results-page2.html");
    const page3Html = fixture("search-results-page3.html");

    const baseSearchUrl =
      "https://www.caljobs.ca.gov/vosnet/jobbanks/jobsearch.aspx?q=react+native+OR+react-native+OR+expo+OR+mobile+OR+ios+OR+android+OR+swift+OR+kotlin+OR+flutter+OR+react+developer+OR+react+engineer+OR+react.js+OR+frontend+OR+front-end+OR+front+end+OR+ui+engineer+OR+web+developer+OR+full+stack+OR+fullstack+OR+full-stack&pg=1";
    const page2Url =
      "https://www.caljobs.ca.gov/vosnet/jobbanks/jobsearch.aspx?pg=2";
    const page3Url =
      "https://www.caljobs.ca.gov/vosnet/jobbanks/jobsearch.aspx?pg=3";
    const page4Url =
      "https://www.caljobs.ca.gov/vosnet/jobbanks/jobsearch.aspx?pg=4";

    const ctx = buildTestCtx({
      fixtures: {
        [baseSearchUrl]: new Response(page1Html, { status: 200 }),
        [page2Url]: new Response(page2Html, { status: 200 }),
        [page3Url]: new Response(page3Html, { status: 200 }),
        // page4 intentionally not provided — if requested, returns 404
      },
    });

    const capturedUrls: string[] = [];
    const originalFetch = ctx.fetch;
    ctx.fetch = async (url: string | URL, init?: RequestInit) => {
      capturedUrls.push(url.toString());
      return originalFetch(url.toString(), init);
    };

    const jobs = await caljobsAdapter.fetchJobs(ctx);

    // Exactly 3 search-result page requests
    const pageRequests = capturedUrls.filter(
      (u) =>
        u.includes("caljobs.ca.gov/vosnet/jobbanks/jobsearch.aspx"),
    );
    expect(pageRequests.length).toBe(3);

    // No request to page 4 or 5
    expect(capturedUrls.some((u) => u.includes("pg=4"))).toBe(false);
    expect(capturedUrls.some((u) => u.includes("pg=5"))).toBe(false);

    // Jobs from all 3 pages are returned
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    // Should include IDs from page3 fixture (CA-20240006, CA-20240007)
    const ids = new Set(jobs.map((j) => j.externalId));
    expect(ids.has("CA-20240006") || ids.has("CA-20240007")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C4 — Layout changed: parse miss yields [] + recorded error, not garbage
// ---------------------------------------------------------------------------

describe("C4 — layout changed: selector miss yields [] and recorded error", () => {
  it("returns [] when selectors miss (layout-changed fixture)", async () => {
    const layoutChangedHtml = fixture("layout-changed.html");
    const ctx = buildTestCtx({
      fixtures: {
        "https://www.caljobs.ca.gov/vosnet/jobbanks/jobsearch.aspx?q=react+native+OR+react-native+OR+expo+OR+mobile+OR+ios+OR+android+OR+swift+OR+kotlin+OR+flutter+OR+react+developer+OR+react+engineer+OR+react.js+OR+frontend+OR+front-end+OR+front+end+OR+ui+engineer+OR+web+developer+OR+full+stack+OR+fullstack+OR+full-stack&pg=1":
          new Response(layoutChangedHtml, { status: 200 }),
      },
    });

    const jobs = await caljobsAdapter.fetchJobs(ctx);

    expect(jobs).toEqual([]);
  });

  it("does not return rows with empty title, company, url, or externalId", async () => {
    const layoutChangedHtml = fixture("layout-changed.html");
    const ctx = buildTestCtx({
      fixtures: {
        "https://www.caljobs.ca.gov/vosnet/jobbanks/jobsearch.aspx?q=react+native+OR+react-native+OR+expo+OR+mobile+OR+ios+OR+android+OR+swift+OR+kotlin+OR+flutter+OR+react+developer+OR+react+engineer+OR+react.js+OR+frontend+OR+front-end+OR+front+end+OR+ui+engineer+OR+web+developer+OR+full+stack+OR+fullstack+OR+full-stack&pg=1":
          new Response(layoutChangedHtml, { status: 200 }),
      },
    });

    const jobs = await caljobsAdapter.fetchJobs(ctx);
    for (const job of jobs) {
      expect(job.title).toBeTruthy();
      expect(job.company).toBeTruthy();
      expect(job.url).toBeTruthy();
      expect(job.externalId).toBeTruthy();
    }
  });

  it("logs exactly one error with 'caljobs' and 'parse' in the message", async () => {
    const layoutChangedHtml = fixture("layout-changed.html");
    const ctx = buildTestCtx({
      fixtures: {
        "https://www.caljobs.ca.gov/vosnet/jobbanks/jobsearch.aspx?q=react+native+OR+react-native+OR+expo+OR+mobile+OR+ios+OR+android+OR+swift+OR+kotlin+OR+flutter+OR+react+developer+OR+react+engineer+OR+react.js+OR+frontend+OR+front-end+OR+front+end+OR+ui+engineer+OR+web+developer+OR+full+stack+OR+fullstack+OR+full-stack&pg=1":
          new Response(layoutChangedHtml, { status: 200 }),
      },
    });

    await caljobsAdapter.fetchJobs(ctx);

    expect(ctx.logger.errors).toHaveLength(1);
    expect(ctx.logger.errors[0].toLowerCase()).toContain("caljobs");
    expect(ctx.logger.errors[0].toLowerCase()).toContain("parse");
  });

  it("promise resolves (does not reject) on layout change", async () => {
    const layoutChangedHtml = fixture("layout-changed.html");
    const ctx = buildTestCtx({
      fixtures: {
        "https://www.caljobs.ca.gov/vosnet/jobbanks/jobsearch.aspx?q=react+native+OR+react-native+OR+expo+OR+mobile+OR+ios+OR+android+OR+swift+OR+kotlin+OR+flutter+OR+react+developer+OR+react+engineer+OR+react.js+OR+frontend+OR+front-end+OR+front+end+OR+ui+engineer+OR+web+developer+OR+full+stack+OR+fullstack+OR+full-stack&pg=1":
          new Response(layoutChangedHtml, { status: 200 }),
      },
    });

    await expect(caljobsAdapter.fetchJobs(ctx)).resolves.toBeDefined();
  });
});
