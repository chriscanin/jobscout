/**
 * Tests for apps/crawler/src/http.ts
 *
 * All tests use injected transport/sleep/clock — no real network calls.
 *
 * Scenarios:
 *  1. Two same-host calls are spaced >= minSpacingMs apart.
 *  2. A 429-then-200 sequence retries and yields the 200 (exactly 2 transport calls).
 *  3. Three consecutive 500s exhaust retries and return the final 500.
 *  4. Retry-After header is respected (sleep is called with that duration).
 *  5. Different hosts are NOT rate-limited against each other.
 *  6. A successful first response is returned immediately (no retry).
 */

import { describe, it, expect, vi } from "vitest";
import { createHttpClient } from "../src/http.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake Response with the given status and optional headers. */
function fakeResponse(
  status: number,
  body = "",
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers });
}

/** Build a transport mock that returns responses in sequence (one per call). */
function sequentialTransport(responses: Response[]) {
  let index = 0;
  const calls: string[] = [];
  const transport = vi.fn(async (url: string, _init?: RequestInit) => {
    calls.push(url);
    const r = responses[index];
    index = Math.min(index + 1, responses.length - 1);
    return r;
  });
  return { transport, calls };
}

/** A synchronous fake clock that auto-advances by `step` ms per call. */
function makeClock(start = 0, step = 0) {
  let t = start;
  return {
    now: () => {
      const current = t;
      t += step;
      return current;
    },
    advance: (ms: number) => { t += ms; },
    set: (ms: number) => { t = ms; },
  };
}

// ---------------------------------------------------------------------------
// 1. Per-host spacing
// ---------------------------------------------------------------------------

describe("per-host spacing", () => {
  it("waits at least minSpacingMs between two calls to the same host", async () => {
    const sleptMs: number[] = [];
    const sleep = async (ms: number) => { sleptMs.push(ms); };

    // The implementation calls now():
    // - first request: no prior entry → spacing check is SKIPPED; 1 call to record lastRequestAt=0
    // - second request: 1 call for elapsed (→ 100ms), then 1 call to record lastRequestAt
    const nowValues = [
      0,     // first request: record lastRequestAt = 0
      100,   // second request: spacing check → elapsed = 100ms → sleep 1900
      100,   // second request: record lastRequestAt
    ];
    let nowIdx = 0;
    const now = () => nowValues[nowIdx++] ?? 100;

    const { transport } = sequentialTransport([
      fakeResponse(200, "first"),
      fakeResponse(200, "second"),
    ]);

    const client = createHttpClient({
      transport,
      sleep,
      now,
      minSpacingMs: 2000,
      maxRetries: 0,
    });

    await client("https://example.com/a");
    await client("https://example.com/b");

    expect(sleptMs).toHaveLength(1);
    expect(sleptMs[0]).toBe(1900); // 2000 - 100
  });

  it("does NOT apply spacing between different hosts", async () => {
    const sleptMs: number[] = [];
    const sleep = async (ms: number) => { sleptMs.push(ms); };
    const now = () => 0;

    const { transport } = sequentialTransport([
      fakeResponse(200, "a"),
      fakeResponse(200, "b"),
    ]);

    const client = createHttpClient({
      transport,
      sleep,
      now,
      minSpacingMs: 2000,
      maxRetries: 0,
    });

    await client("https://host-a.com/jobs");
    await client("https://host-b.com/jobs");

    expect(sleptMs).toHaveLength(0);
  });

  it("does not sleep when elapsed time already exceeds minSpacingMs", async () => {
    const sleptMs: number[] = [];
    const sleep = async (ms: number) => { sleptMs.push(ms); };

    // first request: no prior entry → spacing skipped; 1 call to record → t=0
    // second request: 1 call for elapsed → t=5000 (5000 > 2000 → no sleep); 1 call to record
    const nowValues = [0, 5000, 5000];
    let nowIdx = 0;
    const now = () => nowValues[nowIdx++] ?? 5000;

    const { transport } = sequentialTransport([
      fakeResponse(200),
      fakeResponse(200),
    ]);

    const client = createHttpClient({
      transport,
      sleep,
      now,
      minSpacingMs: 2000,
      maxRetries: 0,
    });

    await client("https://example.com/a");
    await client("https://example.com/b");

    expect(sleptMs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. 429 retry → success
// ---------------------------------------------------------------------------

describe("retry on 429", () => {
  it("retries after a 429 and returns the 200, with exactly 2 transport calls", async () => {
    const sleptMs: number[] = [];
    const sleep = async (ms: number) => { sleptMs.push(ms); };
    const now = () => 99999; // fixed clock so spacing never triggers

    const { transport } = sequentialTransport([
      fakeResponse(429, "rate limited"),
      fakeResponse(200, "ok"),
    ]);

    const client = createHttpClient({
      transport,
      sleep,
      now,
      minSpacingMs: 0,  // disable spacing to isolate retry behavior
      maxRetries: 3,
    });

    const response = await client("https://api.example.com/jobs");

    expect(response.status).toBe(200);
    expect(transport).toHaveBeenCalledTimes(2);
    // Exponential backoff: first retry = 2^0 * 1000 = 1000ms
    expect(sleptMs).toHaveLength(1);
    expect(sleptMs[0]).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// 3. Exhausted retries on 500
// ---------------------------------------------------------------------------

describe("retry exhaustion on 5xx", () => {
  it("returns the final 500 after exhausting all retries (3 transport calls for maxRetries=2)", async () => {
    const sleep = async (_ms: number) => {};
    const now = () => 99999;

    // maxRetries=2 means: initial attempt + 2 retries = 3 total calls
    const { transport } = sequentialTransport([
      fakeResponse(500, "err1"),
      fakeResponse(500, "err2"),
      fakeResponse(500, "err3"),
    ]);

    const client = createHttpClient({
      transport,
      sleep,
      now,
      minSpacingMs: 0,
      maxRetries: 2,
    });

    const response = await client("https://api.example.com/jobs");

    expect(response.status).toBe(500);
    expect(transport).toHaveBeenCalledTimes(3); // attempt 0, 1, 2
  });

  it("returns the final 500 after 4 total calls with maxRetries=3", async () => {
    const sleep = async (_ms: number) => {};
    const now = () => 99999;

    const { transport } = sequentialTransport([
      fakeResponse(503),
      fakeResponse(503),
      fakeResponse(503),
      fakeResponse(503),
    ]);

    const client = createHttpClient({
      transport,
      sleep,
      now,
      minSpacingMs: 0,
      maxRetries: 3,
    });

    const response = await client("https://api.example.com/jobs");

    expect(response.status).toBe(503);
    expect(transport).toHaveBeenCalledTimes(4);
  });
});

// ---------------------------------------------------------------------------
// 4. Retry-After header
// ---------------------------------------------------------------------------

describe("Retry-After header", () => {
  it("sleeps for the integer-seconds value in Retry-After", async () => {
    const sleptMs: number[] = [];
    const sleep = async (ms: number) => { sleptMs.push(ms); };
    const now = () => 99999;

    const { transport } = sequentialTransport([
      fakeResponse(429, "slow down", { "Retry-After": "5" }),
      fakeResponse(200, "ok"),
    ]);

    const client = createHttpClient({
      transport,
      sleep,
      now,
      minSpacingMs: 0,
      maxRetries: 3,
    });

    const response = await client("https://api.example.com/jobs");

    expect(response.status).toBe(200);
    expect(sleptMs).toHaveLength(1);
    expect(sleptMs[0]).toBe(5000); // 5 seconds → 5000ms
  });

  it("sleeps for an HTTP-date Retry-After value", async () => {
    const sleptMs: number[] = [];
    const sleep = async (ms: number) => { sleptMs.push(ms); };

    const baseTime = 1_700_000_000_000; // fixed epoch ms
    const retryAfterDate = new Date(baseTime + 7000).toUTCString(); // 7 seconds later
    const now = () => baseTime;

    const { transport } = sequentialTransport([
      fakeResponse(429, "slow down", { "Retry-After": retryAfterDate }),
      fakeResponse(200, "ok"),
    ]);

    const client = createHttpClient({
      transport,
      sleep,
      now,
      minSpacingMs: 0,
      maxRetries: 3,
    });

    const response = await client("https://api.example.com/jobs");

    expect(response.status).toBe(200);
    expect(sleptMs).toHaveLength(1);
    expect(sleptMs[0]).toBeCloseTo(7000, -2); // within 100ms
  });
});

// ---------------------------------------------------------------------------
// 5. Successful first response — no retry
// ---------------------------------------------------------------------------

describe("successful response", () => {
  it("returns a 200 immediately without any retry", async () => {
    const sleptMs: number[] = [];
    const sleep = async (ms: number) => { sleptMs.push(ms); };
    const now = () => 99999;

    const { transport } = sequentialTransport([fakeResponse(200, "hello")]);

    const client = createHttpClient({
      transport,
      sleep,
      now,
      minSpacingMs: 0,
      maxRetries: 3,
    });

    const response = await client("https://api.example.com/ok");

    expect(response.status).toBe(200);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(sleptMs).toHaveLength(0);
  });

  it("injects a User-Agent header when none is provided", async () => {
    const capturedHeaders: Headers[] = [];
    const transport = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedHeaders.push(new Headers(init?.headers as HeadersInit));
      return fakeResponse(200);
    });

    const client = createHttpClient({
      transport,
      sleep: async () => {},
      now: () => 0,
      minSpacingMs: 0,
      userAgent: "TestAgent/1.0",
    });

    await client("https://example.com/");
    expect(capturedHeaders[0].get("User-Agent")).toBe("TestAgent/1.0");
  });
});

// ---------------------------------------------------------------------------
// 6. Non-retryable errors (4xx other than 429)
// ---------------------------------------------------------------------------

describe("non-retryable errors", () => {
  it("returns a 404 immediately without retrying", async () => {
    const sleep = async (_ms: number) => {};
    const now = () => 99999;

    const { transport } = sequentialTransport([fakeResponse(404, "not found")]);

    const client = createHttpClient({
      transport,
      sleep,
      now,
      minSpacingMs: 0,
      maxRetries: 3,
    });

    const response = await client("https://api.example.com/missing");

    expect(response.status).toBe(404);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
