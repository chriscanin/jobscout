/**
 * The public-read contract.
 *
 * The board is readable by anyone; the pipeline layered on top of it (per-job
 * status and notes) is not. Pages decide which to render from `optionalUser`,
 * so its behaviour is what keeps a stranger from reading the pipeline, and it
 * must never redirect or throw the way `requireAllowedUser` does -- a throw in
 * a public page would take the whole page down for anonymous visitors.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { optionalUser, requireAllowedUser } from "../src/lib/auth";

const ALLOWED = "owner@example.com";

beforeEach(() => {
  process.env.ADMIN_ALLOWED_EMAILS = ALLOWED;
});

describe("optionalUser", () => {
  it("returns null for an anonymous visitor rather than redirecting", async () => {
    await expect(optionalUser(async () => null)).resolves.toBeNull();
  });

  it("returns null for a signed-in but non-allowlisted user", async () => {
    // Not an error: they are simply treated as a member of the public.
    await expect(optionalUser(async () => "stranger@example.com")).resolves.toBeNull();
  });

  it("returns the email for the allowlisted owner", async () => {
    await expect(optionalUser(async () => ALLOWED)).resolves.toBe(ALLOWED);
  });

  it("is case-insensitive about the allowlist, like requireAllowedUser", async () => {
    await expect(optionalUser(async () => "OWNER@Example.com")).resolves.toBe(
      "OWNER@Example.com",
    );
  });

  it("returns null when no allowlist is configured", async () => {
    delete process.env.ADMIN_ALLOWED_EMAILS;
    await expect(optionalUser(async () => ALLOWED)).resolves.toBeNull();
  });
});

describe("requireAllowedUser still guards writes", () => {
  it("throws for an anonymous caller", async () => {
    // Server Actions call this directly, so opening up the read paths does not
    // open up the write paths.
    await expect(requireAllowedUser(async () => null)).rejects.toThrow();
  });

  it("throws for a non-allowlisted caller", async () => {
    await expect(
      requireAllowedUser(async () => "stranger@example.com"),
    ).rejects.toThrow();
  });

  it("returns the email for the allowlisted owner", async () => {
    await expect(requireAllowedUser(async () => ALLOWED)).resolves.toBe(ALLOWED);
  });
});
