/**
 * Password-gate auth mode.
 *
 * Active when ADMIN_PASSWORD is set and Auth0 is not configured (AUTH0_DOMAIN
 * is unset, empty, or still contains a placeholder "<" character).
 *
 * All crypto uses Web Crypto (crypto.subtle) so this module is safe to import
 * from Next.js middleware running on the edge runtime.
 */

export const SESSION_COOKIE = "jobscout_session";

/** True when password-gate mode is active. */
export function passwordAuthEnabled(): boolean {
  const password = process.env.ADMIN_PASSWORD;
  if (!password || password.trim() === "") return false;

  const domain = process.env.AUTH0_DOMAIN ?? "";
  // Auth0 is considered "configured" when the domain is non-empty and
  // contains no placeholder angle-bracket (e.g. "<tenant>.us.auth0.com").
  if (domain !== "" && !domain.includes("<")) return false;

  return true;
}

/** HMAC-SHA256 of ADMIN_PASSWORD keyed on AUTH0_SECRET, as hex. */
export async function expectedToken(): Promise<string> {
  const password = process.env.ADMIN_PASSWORD ?? "";
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

/** Constant-time-ish comparison of the supplied token against expectedToken(). */
export async function isValidToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const expected = await expectedToken();
  if (token.length !== expected.length) return false;
  // Character-by-character XOR accumulation; not cryptographic but sufficient
  // for a session cookie comparison where the secret is already HMAC-derived.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
