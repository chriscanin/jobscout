import { describe, it, expect } from "vitest";
import { ADAPTERS } from "../src/adapters/registry.js";
import { DEFAULT_CRITERIA } from "@jobscout/core";
import { Source } from "@jobscout/core";

describe("ADAPTERS registry", () => {
  it("has exactly 13 adapters", () => {
    expect(ADAPTERS).toHaveLength(13);
  });

  it("all adapter source values are unique", () => {
    const sources = ADAPTERS.map((a) => a.source);
    const unique = new Set(sources);
    expect(unique.size).toBe(sources.length);
  });

  it("adapter sources match the Source enum (excluding 'discovery')", () => {
    // discovery is not a crawlable source adapter — it has no adapter in the registry
    const adapterSources = new Set(ADAPTERS.map((a) => a.source));
    const expectedSources = Source.options.filter((s) => s !== "discovery");
    for (const expected of expectedSources) {
      expect(adapterSources.has(expected)).toBe(true);
    }
  });
});

describe("DEFAULT_CRITERIA", () => {
  it("is importable and has the correct structure", () => {
    expect(DEFAULT_CRITERIA).toBeDefined();
    expect(DEFAULT_CRITERIA.role_priorities).toHaveLength(4);
    expect(DEFAULT_CRITERIA.notify_min_score).toBe(50);
    expect(DEFAULT_CRITERIA.locations.remote_us).toBe(true);
    expect(DEFAULT_CRITERIA.locations.states).toContain("CA");
  });
});
