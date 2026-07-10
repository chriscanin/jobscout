/**
 * Tests for the Lever adapter (spec 02-adapters-api-boards.atdd.md).
 *
 * Scenarios covered:
 *  4. Lever postings parse, with questions always undefined (happy path)
 *  7. 429 succeeds after backoff retry (edge case)
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { leverAdapter } from "../../src/adapters/lever.js";
import { buildTestCtx } from "../helpers/ctx.js";
import { createHttpClient } from "../../src/http.js";
import type { Company } from "@jobscout/core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "../fixtures/lever");

// ---------------------------------------------------------------------------
// Load fixtures
// ---------------------------------------------------------------------------

const boardFixture = JSON.parse(
  readFileSync(resolve(FIXTURES, "board-postings.json"), "utf8"),
) as Record<string, unknown>[];

// ---------------------------------------------------------------------------
// Company row helper
// ---------------------------------------------------------------------------

function exampleCompany(): Company {
  return {
    id: "00000000-0000-0000-0000-000000000010",
    name: "Example Co",
    ats: "lever",
    board_token: "exampleco",
    careers_url: null,
    discovered_via: "seed",
    active: true,
    last_crawled_at: null,
    created_at: null,
  };
}

const POSTINGS_URL = "https://api.lever.co/v0/postings/exampleco?mode=json";

// ---------------------------------------------------------------------------
// Scenario 4: Lever postings parse, with questions always undefined
// ---------------------------------------------------------------------------

describe("Scenario 4: Lever postings parse, questions always undefined", () => {
  it("returns one RawJob per posting with correct field mapping and no questions", async () => {
    const ctx = buildTestCtx({
      companies: [exampleCompany()],
      fixtures: {
        [POSTINGS_URL]: new Response(JSON.stringify(boardFixture), { status: 200 }),
      },
    });

    const jobs = await leverAdapter.fetchJobs(ctx);

    // Length matches fixture array
    expect(jobs).toHaveLength(boardFixture.length);

    // Every job has questions undefined and correct atsHint
    for (const job of jobs) {
      expect(job.questions).toBeUndefined();
      expect(job.atsHint).toBe("lever");
    }

    // First job field mapping
    const first = boardFixture[0];
    const firstJob = jobs[0];
    const categories = first["categories"] as Record<string, unknown> | undefined;

    expect(firstJob.externalId).toBe(String(first["id"]));
    expect(firstJob.url).toBe(String(first["hostedUrl"]));
    expect(firstJob.applyUrl).toBe(String(first["applyUrl"]));
    expect(firstJob.title).toBe(String(first["text"]));
    expect(firstJob.location).toBe(String(categories?.["location"]));

    // postedAt is ISO 8601 conversion of createdAt (epoch ms)
    const createdAtMs = first["createdAt"] as number;
    expect(firstJob.postedAt).toBe(new Date(createdAtMs).toISOString());

    // company comes from the input row
    expect(firstJob.company).toBe("Example Co");
  });
});

// ---------------------------------------------------------------------------
// Scenario 7: 429 succeeds after backoff retry
// ---------------------------------------------------------------------------

describe("Scenario 7: 429 succeeds after backoff retry", () => {
  it("records two transport calls and returns parsed jobs; recordError never called", async () => {
    // Build a sequential transport: 429 first, then 200 with fixture.
    let callCount = 0;
    const transportCalls: string[] = [];
    const sleptMs: number[] = [];

    const transport = vi.fn(async (url: string, _init?: RequestInit) => {
      transportCalls.push(url);
      callCount++;
      if (callCount === 1) {
        return new Response("rate limited", { status: 429 });
      }
      return new Response(JSON.stringify(boardFixture), { status: 200 });
    });

    // Use a no-op sleep so the test doesn't actually wait.
    const sleep = vi.fn(async (ms: number) => { sleptMs.push(ms); });
    const now = vi.fn(() => 999999); // fixed clock — no spacing delay

    const httpClient = createHttpClient({
      transport,
      sleep,
      now,
      minSpacingMs: 0, // disable spacing to isolate retry behavior
      maxRetries: 3,
    });

    // Build a ctx that uses the real http client (with retry) over our mock transport.
    const ctx = buildTestCtx({
      companies: [exampleCompany()],
    });
    // Wrap httpClient to satisfy FetchHelper (string | URL → string).
    const fetchHelper = (input: string | URL, init?: RequestInit) =>
      httpClient(input instanceof URL ? input.toString() : input, init);
    const ctxWithRealHttp = { ...ctx, fetch: fetchHelper };

    const jobs = await leverAdapter.fetchJobs(ctxWithRealHttp);

    // Two transport calls: one 429, one 200
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transportCalls.every((u) => u === POSTINGS_URL)).toBe(true);

    // The result parses identically to Scenario 4
    expect(jobs).toHaveLength(boardFixture.length);
    for (const job of jobs) {
      expect(job.questions).toBeUndefined();
      expect(job.atsHint).toBe("lever");
    }

    // recordError was never called
    expect(ctx.recordedErrors).toHaveLength(0);

    // Sleep was called once (backoff for the 429)
    expect(sleptMs).toHaveLength(1);
  });
});
