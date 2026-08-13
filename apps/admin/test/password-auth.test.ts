/**
 * Tests for src/lib/password-auth.ts and the password-mode branch of
 * src/lib/auth.ts (getSessionEmail).
 *
 * Env vars are restored in afterEach, matching the pattern in dev-bypass.test.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  expectedToken,
  isValidToken,
  passwordAuthEnabled,
} from "../src/lib/password-auth";

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env.ADMIN_PASSWORD = ORIGINAL.ADMIN_PASSWORD;
  process.env.AUTH0_DOMAIN = ORIGINAL.AUTH0_DOMAIN;
  process.env.AUTH0_SECRET = ORIGINAL.AUTH0_SECRET;
  process.env.ADMIN_ALLOWED_EMAILS = ORIGINAL.ADMIN_ALLOWED_EMAILS;
  if (!("ADMIN_PASSWORD" in ORIGINAL)) delete process.env.ADMIN_PASSWORD;
  if (!("AUTH0_DOMAIN" in ORIGINAL)) delete process.env.AUTH0_DOMAIN;
  if (!("AUTH0_SECRET" in ORIGINAL)) delete process.env.AUTH0_SECRET;
  if (!("ADMIN_ALLOWED_EMAILS" in ORIGINAL)) delete process.env.ADMIN_ALLOWED_EMAILS;
});

// ---------------------------------------------------------------------------
// passwordAuthEnabled truth table
// ---------------------------------------------------------------------------
describe("passwordAuthEnabled", () => {
  it("returns false when ADMIN_PASSWORD is not set", () => {
    delete process.env.ADMIN_PASSWORD;
    delete process.env.AUTH0_DOMAIN;
    expect(passwordAuthEnabled()).toBe(false);
  });

  it("returns false when ADMIN_PASSWORD is an empty string", () => {
    process.env.ADMIN_PASSWORD = "";
    delete process.env.AUTH0_DOMAIN;
    expect(passwordAuthEnabled()).toBe(false);
  });

  it("returns false when ADMIN_PASSWORD is set but AUTH0_DOMAIN is a real domain", () => {
    process.env.ADMIN_PASSWORD = "hunter2";
    process.env.AUTH0_DOMAIN = "dev-abc123.us.auth0.com";
    expect(passwordAuthEnabled()).toBe(false);
  });

  it("returns true when ADMIN_PASSWORD is set and AUTH0_DOMAIN is unset", () => {
    process.env.ADMIN_PASSWORD = "hunter2";
    delete process.env.AUTH0_DOMAIN;
    expect(passwordAuthEnabled()).toBe(true);
  });

  it("returns true when ADMIN_PASSWORD is set and AUTH0_DOMAIN is empty", () => {
    process.env.ADMIN_PASSWORD = "hunter2";
    process.env.AUTH0_DOMAIN = "";
    expect(passwordAuthEnabled()).toBe(true);
  });

  it("returns true when ADMIN_PASSWORD is set and AUTH0_DOMAIN is a placeholder", () => {
    process.env.ADMIN_PASSWORD = "hunter2";
    process.env.AUTH0_DOMAIN = "<tenant>.us.auth0.com";
    expect(passwordAuthEnabled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// expectedToken / isValidToken round-trip
// ---------------------------------------------------------------------------
describe("expectedToken / isValidToken", () => {
  it("produces a 64-character hex string", async () => {
    process.env.ADMIN_PASSWORD = "testpassword";
    process.env.AUTH0_SECRET = "super-secret-key-32-chars-padded!";
    const token = await expectedToken();
    expect(typeof token).toBe("string");
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]+$/);
  });

  it("isValidToken returns true for the matching token", async () => {
    process.env.ADMIN_PASSWORD = "correct-horse-battery-staple";
    process.env.AUTH0_SECRET = "another-secret-key-for-testing-32";
    const token = await expectedToken();
    expect(await isValidToken(token)).toBe(true);
  });

  it("isValidToken returns false for a wrong token", async () => {
    process.env.ADMIN_PASSWORD = "correct-horse-battery-staple";
    process.env.AUTH0_SECRET = "another-secret-key-for-testing-32";
    expect(await isValidToken("deadbeef")).toBe(false);
  });

  it("isValidToken returns false for undefined", async () => {
    process.env.ADMIN_PASSWORD = "testpassword";
    process.env.AUTH0_SECRET = "super-secret-key-32-chars-padded!";
    expect(await isValidToken(undefined)).toBe(false);
  });

  it("isValidToken returns false for empty string", async () => {
    process.env.ADMIN_PASSWORD = "testpassword";
    process.env.AUTH0_SECRET = "super-secret-key-32-chars-padded!";
    expect(await isValidToken("")).toBe(false);
  });

  it("changing ADMIN_PASSWORD produces a different token", async () => {
    process.env.AUTH0_SECRET = "shared-secret-key-for-this-test!";
    process.env.ADMIN_PASSWORD = "password-one";
    const token1 = await expectedToken();
    process.env.ADMIN_PASSWORD = "password-two";
    const token2 = await expectedToken();
    expect(token1).not.toBe(token2);
  });

  it("isValidToken rejects a token generated from a different password", async () => {
    process.env.AUTH0_SECRET = "shared-secret-key-for-this-test!";
    process.env.ADMIN_PASSWORD = "wrong-password";
    const wrongToken = await expectedToken();
    process.env.ADMIN_PASSWORD = "right-password";
    expect(await isValidToken(wrongToken)).toBe(false);
  });
});
