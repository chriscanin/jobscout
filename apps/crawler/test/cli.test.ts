/**
 * CLI loop tests — spec 07 Scenario 8 (fake timers).
 *
 * The standing loop is exercised with an injected cycle-runner spy and injected
 * sleep + shouldContinue, so no real crawl executes and the loop terminates
 * deterministically after exactly two cycles.
 */

import { describe, expect, it, vi } from "vitest";
import { runLoop } from "../src/cli.js";

describe("Scenario 8 — loop runs repeated cycles on the interval", () => {
  it("runs exactly two cycles (one at start, one after the sleep), each trigger loop", async () => {
    vi.useFakeTimers();
    try {
      const triggers: string[] = [];
      const runOnce = vi.fn(async () => {
        triggers.push("loop");
      });

      // Run exactly two cycles: shouldContinue returns true for the first two
      // checks and false thereafter (the loop checks it before each cycle).
      let checks = 0;
      const shouldContinue = () => {
        checks += 1;
        return checks <= 2;
      };

      // Real sleep via setTimeout, advanced by fake timers.
      const loopPromise = runLoop({
        runOnce,
        intervalMs: 60_000, // 1 minute
        shouldContinue,
      });

      // Let the first cycle + its scheduled sleep register.
      await vi.advanceTimersByTimeAsync(61_000);
      await loopPromise;

      expect(runOnce).toHaveBeenCalledTimes(2);
      expect(triggers).toEqual(["loop", "loop"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sleep starts only after the cycle finishes (no overlap)", async () => {
    const order: string[] = [];
    let cycle = 0;
    const runOnce = vi.fn(async () => {
      order.push(`cycle-${++cycle}-start`);
      await Promise.resolve();
      order.push(`cycle-${cycle}-end`);
    });
    const sleep = vi.fn(async () => {
      order.push("sleep");
    });
    let checks = 0;
    const shouldContinue = () => {
      checks += 1;
      return checks <= 2;
    };

    await runLoop({ runOnce, intervalMs: 1000, sleep, shouldContinue });

    // Two full cycles; exactly one sleep between them; sleep after cycle 1 ends.
    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(order).toEqual([
      "cycle-1-start",
      "cycle-1-end",
      "sleep",
      "cycle-2-start",
      "cycle-2-end",
    ]);
  });
});
