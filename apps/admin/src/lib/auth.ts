/**
 * Auth gate for the admin app (spec 08 §2).
 *
 * `getSessionEmail()` is the test seam — integration tests stub it directly
 * by importing and replacing the module export rather than running a real
 * Auth0 tenant. The function reads the Auth0 session lazily so `next build`
 * succeeds with no env vars set.
 *
 * `requireAllowedUser()` is the per-page/action guard. It:
 *  1. Calls `getSessionEmail()` — redirects to `/auth/login` if null.
 *  2. Checks `isAllowed(email, ADMIN_ALLOWED_EMAILS)` — triggers a genuine
 *     HTTP 403 (Next.js `forbidden()` -> `forbidden.tsx`) if false.
 *  3. Returns the allowlisted email on success.
 *
 * Both `redirect()` and `forbidden()` throw a Next.js control-flow error
 * (a routing "interrupt"), so a caller that reaches the line after
 * `requireAllowedUser()` is guaranteed to be an authenticated, allowlisted
 * user — no page ever renders content for an unauthorized request.
 */
import { forbidden, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { isAllowed } from "./allowlist";
import { getAuth0Client } from "./auth0";
import { devBypassEmail } from "./dev-bypass";
import { isValidToken, passwordAuthEnabled } from "./password-auth";

/**
 * Returns the authenticated user's email from the current session,
 * or `null` if there is no active session. Designed to be stubbed in tests.
 */
export async function getSessionEmail(): Promise<string | null> {
  // Local-only bypass (see lib/dev-bypass.ts) — allowlist still applies below.
  const bypass = devBypassEmail();
  if (bypass) return bypass;

  // Password-gate mode: validate the session cookie and return the first
  // allowlisted email as the identity (there is no per-user email in this mode).
  if (passwordAuthEnabled()) {
    const jar = await cookies();
    const token = jar.get("jobscout_session")?.value;
    if (!(await isValidToken(token))) return null;
    const csv = process.env.ADMIN_ALLOWED_EMAILS ?? "";
    const first = csv.split(",").map((e) => e.trim()).filter(Boolean)[0];
    return first ?? null;
  }

  const auth0 = getAuth0Client();
  const session = await auth0.getSession();
  return session?.user?.email ?? null;
}

/**
 * Server-side gate used at the top of every Server Component and Server
 * Action that needs auth. Redirects or throws, so callers can trust that
 * the returned email is both authenticated and allowlisted.
 *
 * @param getEmail   Override for the session-email lookup (for unit tests).
 * @returns The allowlisted email address.
 */
export async function requireAllowedUser(
  getEmail: () => Promise<string | null> = getSessionEmail,
): Promise<string> {
  const email = await getEmail();

  if (!email) {
    redirect(passwordAuthEnabled() ? "/login" : "/auth/login");
  }

  const csv = process.env.ADMIN_ALLOWED_EMAILS ?? "";
  if (!isAllowed(email, csv)) {
    // Genuine HTTP 403: forbidden() throws a Next.js routing interrupt whose
    // digest is `NEXT_HTTP_ERROR_FALLBACK;403`, which renders `forbidden.tsx`
    // with a 403 status. Enabled via `experimental.authInterrupts`.
    forbidden();
  }

  return email;
}
