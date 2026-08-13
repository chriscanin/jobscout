/**
 * Tests for src/lib/dev-bypass.ts — the local-only auth bypass must never
 * activate off localhost, and must hand the email through verbatim otherwise.
 */
import { afterEach, describe, expect, it } from "vitest";
import { devBypassEmail } from "../src/lib/dev-bypass";

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env.DEV_FAKE_SESSION_EMAIL = ORIGINAL.DEV_FAKE_SESSION_EMAIL;
  process.env.APP_BASE_URL = ORIGINAL.APP_BASE_URL;
});

describe("devBypassEmail", () => {
  it("returns the email when set and APP_BASE_URL is localhost", () => {
    process.env.DEV_FAKE_SESSION_EMAIL = "chris@example.com";
    process.env.APP_BASE_URL = "http://localhost:3000";
    expect(devBypassEmail()).toBe("chris@example.com");
  });

  it("returns null when APP_BASE_URL is a deployed https origin", () => {
    process.env.DEV_FAKE_SESSION_EMAIL = "chris@example.com";
    process.env.APP_BASE_URL = "https://jobscout-admin.vercel.app";
    expect(devBypassEmail()).toBeNull();
  });

  it("returns null when the email is unset or blank", () => {
    process.env.APP_BASE_URL = "http://localhost:3000";
    process.env.DEV_FAKE_SESSION_EMAIL = "";
    expect(devBypassEmail()).toBeNull();
    delete process.env.DEV_FAKE_SESSION_EMAIL;
    expect(devBypassEmail()).toBeNull();
  });

  it("returns null when APP_BASE_URL is unset", () => {
    delete process.env.APP_BASE_URL;
    process.env.DEV_FAKE_SESSION_EMAIL = "chris@example.com";
    expect(devBypassEmail()).toBeNull();
  });
});
