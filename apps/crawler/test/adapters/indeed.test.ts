/**
 * ATDD spec 03 — Indeed adapter tests (I1–I4)
 *
 * All tests run fully offline: ctx.fetch is stubbed from fixture files.
 * Global fetch throws if called (enforced by vi.stubGlobal below).
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { indeedAdapter } from "../../src/adapters/indeed.js";
import { buildTestCtx } from "../helpers/ctx.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURE_DIR = join(
  new URL(".", import.meta.url).pathname,
  "../fixtures/indeed",
);

function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

// Stub global fetch to throw — any adapter bypassing ctx.fetch will fail
vi.stubGlobal("fetch", () => {
  throw new Error("Global fetch must not be called in tests — use ctx.fetch");
});

// The initial search URL the Indeed adapter builds with DEFAULT_CRITERIA keywords
const SEARCH_URL =
  "https://www.indeed.com/jobs?q=react+native+react-native+expo+mobile+ios+android+swift+kotlin+flutter+react+developer+react+engineer+react.js+frontend+front-end+front+end+ui+engineer+web+developer+full+stack+fullstack+full-stack&l=remote&remotejob=032b3046-06a3-4876-8dfd-474eb5e7ed11";

// ---------------------------------------------------------------------------
// I1 — Happy path: external_id from jk param, tracking junk discarded
// ---------------------------------------------------------------------------

describe("I1 — happy path: jk extraction and stable ids", () => {
  it("returns ≥ 1 RawJob with source=indeed and correct shape", async () => {
    const page1Html = fixture("search-results-page1.html");
    const ctx = buildTestCtx({
      fixtures: { [SEARCH_URL]: new Response(page1Html, { status: 200 }) },
    });

    const jobs = await indeedAdapter.fetchJobs(ctx);

    expect(jobs.length).toBeGreaterThanOrEqual(1);
    for (const job of jobs) {
      expect(job.source).toBe("indeed");
      expect(job.externalId).toBeTruthy();
      expect(job.externalId).toMatch(/^[0-9a-f]+$/i);
      expect(job.url).toBe(`https://www.indeed.com/viewjob?jk=${job.externalId}`);
    }
  });

  it("strips tracking params — externalId equals jk value only", async () => {
    const page1Html = fixture("search-results-page1.html");
    const ctx = buildTestCtx({
      fixtures: { [SEARCH_URL]: new Response(page1Html, { status: 200 }) },
    });

    const jobs = await indeedAdapter.fetchJobs(ctx);

    // beef789cafe0002b has extra params (fccid, vjs, from, tk, sal) in its href
    const job = jobs.find((j) => j.externalId === "beef789cafe0002b");
    expect(job).toBeDefined();
    expect(job!.externalId).toBe("beef789cafe0002b");
    expect(job!.url).toBe("https://www.indeed.com/viewjob?jk=beef789cafe0002b");
  });

  it("returns identical sorted externalId list on second call (byte-stability)", async () => {
    const page1Html = fixture("search-results-page1.html");
    const makeCtx = () =>
      buildTestCtx({
        fixtures: { [SEARCH_URL]: new Response(page1Html, { status: 200 }) },
      });

    const jobs1 = await indeedAdapter.fetchJobs(makeCtx());
    const jobs2 = await indeedAdapter.fetchJobs(makeCtx());

    const ids1 = jobs1.map((j) => j.externalId).sort();
    const ids2 = jobs2.map((j) => j.externalId).sort();
    expect(ids1).toEqual(ids2);
    expect(ids1.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// I2 — Blocked with HTTP 403: empty array, recorded error, no further requests
// ---------------------------------------------------------------------------

describe("I2 — blocked with HTTP 403", () => {
  it("returns [] on 403", async () => {
    const blockedHtml = fixture("blocked-403.html");
    const ctx = buildTestCtx({
      fixtures: { [SEARCH_URL]: new Response(blockedHtml, { status: 403 }) },
    });

    const jobs = await indeedAdapter.fetchJobs(ctx);
    expect(jobs).toEqual([]);
  });

  it("logs exactly one error containing 'indeed', '403', and 'blocked'", async () => {
    const blockedHtml = fixture("blocked-403.html");
    const ctx = buildTestCtx({
      fixtures: { [SEARCH_URL]: new Response(blockedHtml, { status: 403 }) },
    });

    await indeedAdapter.fetchJobs(ctx);

    expect(ctx.logger.errors).toHaveLength(1);
    const msg = ctx.logger.errors[0].toLowerCase();
    expect(msg).toContain("indeed");
    expect(msg).toContain("403");
    expect(msg).toContain("blocked");
  });

  it("makes no further requests after the blocked response", async () => {
    const blockedHtml = fixture("blocked-403.html");
    const ctx = buildTestCtx({
      fixtures: { [SEARCH_URL]: new Response(blockedHtml, { status: 403 }) },
    });

    const capturedUrls: string[] = [];
    const originalFetch = ctx.fetch;
    ctx.fetch = async (url: string | URL, init?: RequestInit) => {
      capturedUrls.push(url.toString());
      return originalFetch(url.toString(), init);
    };

    await indeedAdapter.fetchJobs(ctx);

    // Only the initial blocked request — no retries, no alternate endpoints
    expect(capturedUrls).toHaveLength(1);
    // All requests must be to *.indeed.com
    for (const u of capturedUrls) {
      expect(u).toMatch(/indeed\.com/);
    }
  });

  it("promise resolves (does not reject) on 403", async () => {
    const blockedHtml = fixture("blocked-403.html");
    const ctx = buildTestCtx({
      fixtures: { [SEARCH_URL]: new Response(blockedHtml, { status: 403 }) },
    });

    await expect(indeedAdapter.fetchJobs(ctx)).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// I3 — Challenge page with HTTP 200 is detected as blocked
// ---------------------------------------------------------------------------

describe("I3 — 200-status challenge page detected as blocked", () => {
  it("returns [] when body is a challenge page served with status 200", async () => {
    const blockedHtml = fixture("blocked-403.html"); // body is a real challenge page
    const ctx = buildTestCtx({
      fixtures: { [SEARCH_URL]: new Response(blockedHtml, { status: 200 }) },
    });

    const jobs = await indeedAdapter.fetchJobs(ctx);
    expect(jobs).toEqual([]);
  });

  it("logs exactly one error containing 'indeed' and 'challenge' for 200-status block", async () => {
    const blockedHtml = fixture("blocked-403.html");
    const ctx = buildTestCtx({
      fixtures: { [SEARCH_URL]: new Response(blockedHtml, { status: 200 }) },
    });

    await indeedAdapter.fetchJobs(ctx);

    expect(ctx.logger.errors).toHaveLength(1);
    const msg = ctx.logger.errors[0].toLowerCase();
    expect(msg).toContain("indeed");
    expect(msg).toContain("challenge");
  });

  it("makes no further requests after detecting a 200-status challenge", async () => {
    const blockedHtml = fixture("blocked-403.html");
    const ctx = buildTestCtx({
      fixtures: { [SEARCH_URL]: new Response(blockedHtml, { status: 200 }) },
    });

    const capturedUrls: string[] = [];
    const originalFetch = ctx.fetch;
    ctx.fetch = async (url: string | URL, init?: RequestInit) => {
      capturedUrls.push(url.toString());
      return originalFetch(url.toString(), init);
    };

    await indeedAdapter.fetchJobs(ctx);

    expect(capturedUrls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// I4 — Pagination stops at the 3-page cap
// ---------------------------------------------------------------------------

describe("I4 — pagination stops at 3-page cap", () => {
  it("fetches exactly 3 pages and no page-4+ URL appears", async () => {
    const page1Html = fixture("search-results-page1.html");
    const page2Html = fixture("search-results-page2.html");
    const page3Html = fixture("search-results-page3.html");

    // Indeed pagination: page1 links to ?start=10, page2 to ?start=20, page3 to ?start=30
    const page2Url = "https://www.indeed.com/jobs?q=react+developer&l=remote&start=10";
    const page3Url = "https://www.indeed.com/jobs?q=react+developer&l=remote&start=20";
    const page4Url = "https://www.indeed.com/jobs?q=react+developer&l=remote&start=30";

    const ctx = buildTestCtx({
      fixtures: {
        [SEARCH_URL]: new Response(page1Html, { status: 200 }),
        [page2Url]: new Response(page2Html, { status: 200 }),
        [page3Url]: new Response(page3Html, { status: 200 }),
        // page4 intentionally not provided
      },
    });

    const capturedUrls: string[] = [];
    const originalFetch = ctx.fetch;
    ctx.fetch = async (url: string | URL, init?: RequestInit) => {
      capturedUrls.push(url.toString());
      return originalFetch(url.toString(), init);
    };

    const jobs = await indeedAdapter.fetchJobs(ctx);

    // Exactly 3 page requests total
    expect(capturedUrls).toHaveLength(3);

    // No page 4 URL requested
    expect(capturedUrls.some((u) => u.includes("start=30"))).toBe(false);

    // Jobs from all 3 pages
    expect(jobs.length).toBeGreaterThanOrEqual(1);
  });
});
