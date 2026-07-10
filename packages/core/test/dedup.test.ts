import { describe, expect, it } from "vitest";
import { dedupHash } from "../src/dedup.js";

describe("dedupHash", () => {
  it("treats punctuation/case variants of the same company as equal", () => {
    expect(dedupHash("Mattermost, Inc.", "Senior Engineer", "Remote")).toBe(
      dedupHash("mattermost inc", "senior engineer", "remote"),
    );
  });

  it("treats a null location the same as a missing location", () => {
    expect(dedupHash("Acme", "Engineer", null)).toBe(
      dedupHash("Acme", "Engineer"),
    );
  });

  it("treats a null location the same as an empty-string location", () => {
    expect(dedupHash("Acme", "Engineer", null)).toBe(
      dedupHash("Acme", "Engineer", ""),
    );
  });

  it("differs when the title differs", () => {
    expect(dedupHash("Acme", "Frontend Engineer", "Remote")).not.toBe(
      dedupHash("Acme", "Backend Engineer", "Remote"),
    );
  });
});
