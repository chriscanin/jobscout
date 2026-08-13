/**
 * Tests for the HN "Who is hiring" adapter.
 *
 * Scenarios covered:
 *  1. Happy path: newest matching thread selected, comments map to RawJobs
 *  2. Deleted (null-text) and empty-text comments are skipped
 *  3. Non-200 search response → recordError called, [] returned, no throw
 *
 * All tests run fully offline: ctx.fetch is stubbed from inline fixtures.
 */

import { describe, it, expect, vi } from "vitest";
import { hnAdapter } from "../../src/adapters/hn.js";
import { buildTestCtx } from "../helpers/ctx.js";

// Stub global fetch to throw — any adapter bypassing ctx.fetch will fail
vi.stubGlobal("fetch", () => {
  throw new Error("Global fetch must not be called in tests — use ctx.fetch");
});

const SEARCH_URL =
  "https://hn.algolia.com/api/v1/search_by_date?query=%22who%20is%20hiring%22&tags=story,author_whoishiring";
const ITEM_URL = "https://hn.algolia.com/api/v1/items/44001000";

// ---------------------------------------------------------------------------
// Inline fixtures
// ---------------------------------------------------------------------------

// Deliberately unordered: the older matching thread comes first, and a newer
// NON-matching story ("Who wants to be hired?") is newest overall. The adapter
// must pick 44001000 — the newest hit matching /^Ask HN: Who is hiring\?/.
const searchFixture = {
  hits: [
    {
      objectID: "43000001",
      title: "Ask HN: Who is hiring? (July 2026)",
      created_at: "2026-07-01T15:00:00.000Z",
    },
    {
      objectID: "44001099",
      title: "Ask HN: Who wants to be hired? (August 2026)",
      created_at: "2026-08-01T15:05:00.000Z",
    },
    {
      objectID: "44001000",
      title: "Ask HN: Who is hiring? (August 2026)",
      created_at: "2026-08-01T15:00:00.000Z",
    },
  ],
};

const acmeText =
  "Acme &amp; Co | Senior React Native Engineer | Remote (US)<p>We build tools. " +
  "Apply at https:&#x2F;&#x2F;acme.example&#x2F;jobs</p>";

const itemFixture = {
  id: 44001000,
  children: [
    {
      id: 44001201,
      author: "alice",
      text: acmeText,
      created_at: "2026-08-01T16:00:00.000Z",
      children: [{ id: 44001999, author: "replyguy", text: "Is this remote?" }],
    },
    {
      id: 44001202,
      author: "bob",
      text: null, // deleted comment
      created_at: "2026-08-01T16:05:00.000Z",
      children: [],
    },
    {
      id: 44001203,
      author: "carol",
      text: "   ", // effectively empty
      created_at: "2026-08-01T16:10:00.000Z",
      children: [],
    },
  ],
};

// ---------------------------------------------------------------------------
// Scenario 1: happy path — thread selection + field mapping
// ---------------------------------------------------------------------------

describe("Scenario 1: picks newest matching thread and maps comments", () => {
  it("fetches the newest 'Ask HN: Who is hiring?' thread and maps fields", async () => {
    const ctx = buildTestCtx({
      fixtures: {
        [SEARCH_URL]: new Response(JSON.stringify(searchFixture), { status: 200 }),
        [ITEM_URL]: new Response(JSON.stringify(itemFixture), { status: 200 }),
      },
    });

    const jobs = await hnAdapter.fetchJobs(ctx);

    // Only the non-deleted, non-empty comment becomes a job
    expect(jobs).toHaveLength(1);

    const job = jobs[0];
    expect(job.source).toBe("hn");
    expect(job.externalId).toBe("44001201");
    expect(job.url).toBe("https://news.ycombinator.com/item?id=44001201");
    // Title: first line of HTML-stripped, entity-decoded text
    expect(job.title).toBe("Acme & Co | Senior React Native Engineer | Remote (US)");
    // Company: first "|"-separated segment
    expect(job.company).toBe("Acme & Co");
    // Description keeps the full raw HTML
    expect(job.description).toBe(acmeText);
    expect(job.postedAt).toBe("2026-08-01T16:00:00.000Z");
    expect(ctx.recordedErrors).toHaveLength(0);
  });

  it("strips nested replies from raw", async () => {
    const ctx = buildTestCtx({
      fixtures: {
        [SEARCH_URL]: new Response(JSON.stringify(searchFixture), { status: 200 }),
        [ITEM_URL]: new Response(JSON.stringify(itemFixture), { status: 200 }),
      },
    });

    const jobs = await hnAdapter.fetchJobs(ctx);

    const raw = jobs[0].raw as Record<string, unknown>;
    expect(raw["children"]).toBeUndefined();
    expect(raw["id"]).toBe(44001201);
    expect(raw["author"]).toBe("alice");
  });

  it("truncates title to 140 chars and company to 80 chars", async () => {
    const longSegment = "X".repeat(200);
    const longItem = {
      id: 44001000,
      children: [
        {
          id: 44001300,
          author: "dave",
          text: `${longSegment} | Engineer<p>Details</p>`,
          created_at: "2026-08-01T17:00:00.000Z",
          children: [],
        },
      ],
    };
    const ctx = buildTestCtx({
      fixtures: {
        [SEARCH_URL]: new Response(JSON.stringify(searchFixture), { status: 200 }),
        [ITEM_URL]: new Response(JSON.stringify(longItem), { status: 200 }),
      },
    });

    const jobs = await hnAdapter.fetchJobs(ctx);

    expect(jobs).toHaveLength(1);
    expect(jobs[0].title).toHaveLength(140);
    expect(jobs[0].company).toBe("X".repeat(80));
  });

  it("falls back to the author when the company segment is blank", async () => {
    const blankCompanyItem = {
      id: 44001000,
      children: [
        {
          id: 44001400,
          author: "eve",
          text: " | Frontend Engineer | Remote<p>Details</p>",
          created_at: "2026-08-01T18:00:00.000Z",
          children: [],
        },
      ],
    };
    const ctx = buildTestCtx({
      fixtures: {
        [SEARCH_URL]: new Response(JSON.stringify(searchFixture), { status: 200 }),
        [ITEM_URL]: new Response(JSON.stringify(blankCompanyItem), { status: 200 }),
      },
    });

    const jobs = await hnAdapter.fetchJobs(ctx);

    expect(jobs).toHaveLength(1);
    expect(jobs[0].company).toBe("eve");
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: failure paths — recordError, [] returned, nothing thrown
// ---------------------------------------------------------------------------

describe("Scenario 2: failure paths record errors and return []", () => {
  it("non-200 search response → recordError called, [] returned", async () => {
    const ctx = buildTestCtx({
      fixtures: {
        [SEARCH_URL]: new Response("oops", { status: 500 }),
      },
    });

    await expect(hnAdapter.fetchJobs(ctx)).resolves.toEqual([]);
    expect(ctx.recordedErrors).toHaveLength(1);
    expect(ctx.recordedErrors[0]).toContain("hn");
    expect(ctx.recordedErrors[0]).toContain("500");
  });

  it("non-200 items response → recordError called, [] returned", async () => {
    const ctx = buildTestCtx({
      fixtures: {
        [SEARCH_URL]: new Response(JSON.stringify(searchFixture), { status: 200 }),
        // ITEM_URL missing → buildTestCtx returns 404
      },
    });

    await expect(hnAdapter.fetchJobs(ctx)).resolves.toEqual([]);
    expect(ctx.recordedErrors).toHaveLength(1);
    expect(ctx.recordedErrors[0]).toContain("44001000");
    expect(ctx.recordedErrors[0]).toContain("404");
  });

  it("no matching thread → recordError called, [] returned", async () => {
    const noMatch = { hits: [searchFixture.hits[1]] }; // only "Who wants to be hired?"
    const ctx = buildTestCtx({
      fixtures: {
        [SEARCH_URL]: new Response(JSON.stringify(noMatch), { status: 200 }),
      },
    });

    await expect(hnAdapter.fetchJobs(ctx)).resolves.toEqual([]);
    expect(ctx.recordedErrors).toHaveLength(1);
    expect(ctx.recordedErrors[0]).toContain("hn");
  });
});
