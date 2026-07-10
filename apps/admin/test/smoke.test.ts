import { describe, it, expect } from "vitest";
import { isAllowed } from "../src/lib/allowlist.js";

describe("isAllowed", () => {
  it("returns true for an email in the csv", () => {
    expect(isAllowed("chris@example.com", "chris@example.com,other@example.com")).toBe(true);
  });

  it("returns false for an email not in the csv", () => {
    expect(isAllowed("stranger@example.com", "chris@example.com,other@example.com")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isAllowed("Chris@Example.COM", "chris@example.com")).toBe(true);
  });

  it("trims whitespace around entries", () => {
    expect(isAllowed("chris@example.com", "  chris@example.com ,  other@example.com  ")).toBe(true);
  });

  it("returns false for an empty csv", () => {
    expect(isAllowed("chris@example.com", "")).toBe(false);
  });

  it("returns false for a whitespace-only csv", () => {
    expect(isAllowed("chris@example.com", "   ")).toBe(false);
  });
});
