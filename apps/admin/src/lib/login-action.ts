"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { expectedToken, isValidToken } from "./password-auth";

const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

/**
 * Server action for the password-gate login form.
 *
 * Validates the submitted password (timing-safe via isValidToken), sets the
 * jobscout_session cookie on success, and redirects. On failure redirects to
 * /login?error=1.
 */
export async function loginAction(formData: FormData): Promise<never> {
  const submitted = String(formData.get("password") ?? "");
  const adminPassword = process.env.ADMIN_PASSWORD ?? "";

  // Derive both sides from the same HMAC path so comparison is timing-safe
  // (isValidToken compares hex strings character-by-character).
  // Build a token from the submitted value and compare to the real token.
  const submittedToken = await buildTokenForPassword(submitted);
  const valid = await isValidToken(submittedToken);

  if (!valid) {
    const returnTo = String(formData.get("returnTo") ?? "");
    const failUrl = new URL(
      "/login",
      process.env.APP_BASE_URL ?? "http://localhost:3100",
    );
    failUrl.searchParams.set("error", "1");
    if (returnTo.startsWith("/")) {
      failUrl.searchParams.set("returnTo", returnTo);
    }
    redirect(failUrl.pathname + failUrl.search);
  }

  // Suppress unused warning — adminPassword is intentionally compared via HMAC
  void adminPassword;

  const token = await expectedToken();
  const secure = (process.env.APP_BASE_URL ?? "").startsWith("https");

  const jar = await cookies();
  jar.set("jobscout_session", token, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });

  const returnTo = String(formData.get("returnTo") ?? "");
  redirect(returnTo.startsWith("/") ? returnTo : "/");
}

/**
 * Builds the HMAC token for an arbitrary password value.
 * Mirrors expectedToken() but with a caller-supplied password so we can do a
 * timing-safe comparison without exposing ADMIN_PASSWORD directly.
 */
async function buildTokenForPassword(password: string): Promise<string> {
  const secret = process.env.AUTH0_SECRET ?? "";
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(password));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
