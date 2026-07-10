import { describe, expect, it } from "vitest";
import {
  ALLOWED_TRANSITIONS,
  InvalidTransitionError,
  isAllowedTransition,
} from "../src/status.js";

describe("isAllowedTransition", () => {
  it("allows a legal transition (new -> notified)", () => {
    expect(isAllowedTransition("new", "notified")).toBe(true);
  });

  it("rejects an illegal transition (applied -> notified)", () => {
    expect(isAllowedTransition("applied", "notified")).toBe(false);
  });

  it("has exactly the 11 pairs from the contract", () => {
    expect(ALLOWED_TRANSITIONS).toHaveLength(11);
  });
});

describe("InvalidTransitionError", () => {
  it("carries the from/to and a descriptive message", () => {
    const err = new InvalidTransitionError("applied", "notified");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("InvalidTransitionError");
    expect(err.from).toBe("applied");
    expect(err.to).toBe("notified");
    expect(err.message).toContain("applied -> notified");
  });
});
