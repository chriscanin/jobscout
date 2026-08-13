/**
 * ATDD spec 03 — ZipRecruiter adapter tests (Z1–Z3)
 *
 * All tests run fully offline: ctx.fetch is stubbed from fixture files.
 * Global fetch throws if called (enforced by vi.stubGlobal below).
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { ziprecruiterAdapter } from "../../src/adapters/ziprecruiter.js";
import { buildTestCtx } from "../helpers/ctx.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURE_DIR = join(
  new URL(".", import.meta.url).pathname,
  "../fixtures/ziprecruiter",
);

function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

// Stub global fetch to throw — any adapter bypassing ctx.fetch will fail
vi.stubGlobal("fetch", () => {
  throw new Error("Global fetch must not be called in tests — use ctx.fetch");
});

// The initial search URL the ZipRecruiter adapter builds with DEFAULT_CRITERIA keywords
const SEARCH_URL =
  "https://www.ziprecruiter.com/jobs-search?search=react+native+react-native+expo+mobile+ios+android+swift+kotlin+flutter+react+developer+react+engineer+react.js+frontend+front-end+front+end+ui+engineer+web+developer+full+stack+fullstack+full-stack&location=Remote";

// ---------------------------------------------------------------------------
// Z1 — Happy path: external_id from listing id in URL
// ---------------------------------------------------------------------------

describe("Z1 — happy path: listing id extraction and stable ids", () => {
  it("returns ≥ 1 RawJob with source=ziprecruiter and correct shape", async () => {
    const page1Html = fixture("search-results-page1.html");
    const ctx = buildTestCtx({
      fixtures: { [SEARCH_URL]: new Response(page1Html, { status: 200 }) },
    });

    const jobs = await ziprecruiterAdapter.fetchJobs(ctx);

    expect(jobs.length).toBeGreaterThanOrEqual(1);
    for (const job of jobs) {
      expect(job.source).toBe("ziprecruiter");
      expect(job.title).toBeTruthy();
      expect(job.company).toBeTruthy();
      expect(job.url).toMatch(/ziprecruiter\.com/);
      expect(job.externalId).toBeTruthy();
      // externalId must contain no ?, &, =, or /
      expect(job.externalId).not.toMatch(/[?&=/]/);
    }
  });

  it("externalIds within the page are unique", async () => {
    const page1Html = fixture("search-results-page1.html");
    const ctx = buildTestCtx({
      fixtures: { [SEARCH_URL]: new Response(page1Html, { status: 200 }) },
    });

    const jobs = await ziprecruiterAdapter.fetchJobs(ctx);
    const ids = jobs.map((j) => j.externalId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(1);
  });

  it("returns identical sorted externalId list on second call (byte-stability)", async () => {
    const page1Html = fixture("search-results-page1.html");
    const makeCtx = () =>
      buildTestCtx({
        fixtures: { [SEARCH_URL]: new Response(page1Html, { status: 200 }) },
      });

    const jobs1 = await ziprecruiterAdapter.fetchJobs(makeCtx());
    const jobs2 = await ziprecruiterAdapter.fetchJobs(makeCtx());

    const ids1 = jobs1.map((j) => j.externalId).sort();
    const ids2 = jobs2.map((j) => j.externalId).sort();
    expect(ids1).toEqual(ids2);
    expect(ids1.length).toBeGreaterThanOrEqual(1);
  });

  it("extracts listing ids matching the fixture job ids", async () => {
    const page1Html = fixture("search-results-page1.html");
    const ctx = buildTestCtx({
      fixtures: { [SEARCH_URL]: new Response(page1Html, { status: 200 }) },
    });

    const jobs = await ziprecruiterAdapter.fetchJobs(ctx);
    const ids = new Set(jobs.map((j) => j.externalId));

    // The fixture has these listing ids embedded in the URLs
    expect(ids.has("j3n5v0680ctp58bvnbx")).toBe(true);
    expect(ids.has("j3q6t174xmxlmyw91ry")).toBe(true);
    expect(ids.has("j3r8p259ynylnzw02sz")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Z2 — Blocked with HTTP 429: empty array, recorded error, run continues
// ---------------------------------------------------------------------------

describe("Z2 — blocked with HTTP 429", () => {
  it("returns [] on 429", async () => {
    const blockedHtml = fixture("blocked-429.html");
    const ctx = buildTestCtx({
      fixtures: { [SEARCH_URL]: new Response(blockedHtml, { status: 429 }) },
    });

    const jobs = await ziprecruiterAdapter.fetchJobs(ctx);
    expect(jobs).toEqual([]);
  });

  it("promise resolves (does not reject) on 429", async () => {
    const blockedHtml = fixture("blocked-429.html");
    const ctx = buildTestCtx({
      fixtures: { [SEARCH_URL]: new Response(blockedHtml, { status: 429 }) },
    });

    await expect(ziprecruiterAdapter.fetchJobs(ctx)).resolves.toEqual([]);
  });

  it("logs exactly one error containing 'ziprecruiter', '429', and 'blocked'", async () => {
    const blockedHtml = fixture("blocked-429.html");
    const ctx = buildTestCtx({
      fixtures: { [SEARCH_URL]: new Response(blockedHtml, { status: 429 }) },
    });

    await ziprecruiterAdapter.fetchJobs(ctx);

    expect(ctx.logger.errors).toHaveLength(1);
    const msg = ctx.logger.errors[0].toLowerCase();
    expect(msg).toContain("ziprecruiter");
    expect(msg).toContain("429");
    expect(msg).toContain("blocked");
  });

  it("makes no further requests after the blocked response", async () => {
    const blockedHtml = fixture("blocked-429.html");
    const ctx = buildTestCtx({
      fixtures: { [SEARCH_URL]: new Response(blockedHtml, { status: 429 }) },
    });

    const capturedUrls: string[] = [];
    const originalFetch = ctx.fetch;
    ctx.fetch = async (url: string | URL, init?: RequestInit) => {
      capturedUrls.push(url.toString());
      return originalFetch(url.toString(), init);
    };

    await ziprecruiterAdapter.fetchJobs(ctx);

    expect(capturedUrls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Z3 — Layout changed: empty array plus recorded parse error, not garbage rows
// ---------------------------------------------------------------------------

describe("Z3 — layout changed: selector miss yields [] and recorded error", () => {
  it("returns [] when selectors miss (layout-changed fixture)", async () => {
    const layoutChangedHtml = fixture("layout-changed.html");
    const ctx = buildTestCtx({
      fixtures: { [SEARCH_URL]: new Response(layoutChangedHtml, { status: 200 }) },
    });

    const jobs = await ziprecruiterAdapter.fetchJobs(ctx);
    expect(jobs).toEqual([]);
  });

  it("does not return rows with empty title, company, url, or externalId", async () => {
    const layoutChangedHtml = fixture("layout-changed.html");
    const ctx = buildTestCtx({
      fixtures: { [SEARCH_URL]: new Response(layoutChangedHtml, { status: 200 }) },
    });

    const jobs = await ziprecruiterAdapter.fetchJobs(ctx);
    for (const job of jobs) {
      expect(job.title).toBeTruthy();
      expect(job.company).toBeTruthy();
      expect(job.url).toBeTruthy();
      expect(job.externalId).toBeTruthy();
    }
  });

  it("logs exactly one error containing 'ziprecruiter' and 'parse'", async () => {
    const layoutChangedHtml = fixture("layout-changed.html");
    const ctx = buildTestCtx({
      fixtures: { [SEARCH_URL]: new Response(layoutChangedHtml, { status: 200 }) },
    });

    await ziprecruiterAdapter.fetchJobs(ctx);

    expect(ctx.logger.errors).toHaveLength(1);
    const msg = ctx.logger.errors[0].toLowerCase();
    expect(msg).toContain("ziprecruiter");
    expect(msg).toContain("parse");
  });
});
