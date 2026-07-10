import { describe, expect, it } from "vitest";
import { Ats, Difficulty, RoleCategory, Source, Status } from "../src/enums.js";
import { Criteria, DEFAULT_CRITERIA } from "../src/schemas.js";

describe("DEFAULT_CRITERIA", () => {
  it("parses against the Criteria schema", () => {
    expect(() => Criteria.parse(DEFAULT_CRITERIA)).not.toThrow();
    expect(DEFAULT_CRITERIA.notify_min_score).toBe(50);
  });

  it("rejects a malformed criteria object", () => {
    const bad = {
      ...DEFAULT_CRITERIA,
      notify_min_score: "high", // should be a number
    };
    expect(Criteria.safeParse(bad).success).toBe(false);
  });
});

describe("enums reject unknown values", () => {
  it("Source", () => {
    expect(Source.safeParse("monster").success).toBe(false);
    expect(Source.safeParse("greenhouse").success).toBe(true);
  });
  it("Ats", () => {
    expect(Ats.safeParse("bamboo").success).toBe(false);
    expect(Ats.safeParse("workday").success).toBe(true);
  });
  it("RoleCategory", () => {
    expect(RoleCategory.safeParse("devops").success).toBe(false);
    expect(RoleCategory.safeParse("react-native").success).toBe(true);
  });
  it("Difficulty", () => {
    expect(Difficulty.safeParse("trivial").success).toBe(false);
    expect(Difficulty.safeParse("easy").success).toBe(true);
  });
  it("Status", () => {
    expect(Status.safeParse("archived").success).toBe(false);
    expect(Status.safeParse("new").success).toBe(true);
  });
});
