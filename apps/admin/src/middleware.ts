/**
 * Auth0 v4 middleware (spec 08 §2).
 *
 * In v4, auth0.middleware(request) automatically mounts the SDK routes
 * (/auth/login, /auth/callback, /auth/logout) — no separate route handler
 * is required.
 *
 * For non-auth routes, we additionally check for an active session and
 * redirect unauthenticated requests to /auth/login with a returnTo param.
 *
 * Env vars required by @auth0/nextjs-auth0 v4:
 *   AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET, AUTH0_SECRET, APP_BASE_URL
 */
import { type NextRequest, NextResponse } from "next/server";
import { getAuth0Client } from "./lib/auth0";
import { devBypassEmail } from "./lib/dev-bypass";
import { passwordAuthEnabled } from "./lib/password-auth";

export async function middleware(request: NextRequest) {
  // Local-only bypass (see lib/dev-bypass.ts): skip the Auth0 middleware —
  // pages still enforce the allowlist via requireAllowedUser.
  if (devBypassEmail()) {
    return NextResponse.next();
  }

  // Password-gate mode: no Auth0 tenant required. The gate is opt-in per page
  // now rather than blanket, so nothing is redirected here.
  if (passwordAuthEnabled()) {
    return NextResponse.next();
  }

  const auth0 = getAuth0Client();
  const authRes = await auth0.middleware(request);

  // /auth/* routes are owned by the SDK middleware — return its response directly
  if (request.nextUrl.pathname.startsWith("/auth")) {
    return authRes;
  }

  // No session check here. Reading the board does not require an account, and
  // the pages that expose the pipeline call `optionalUser`, while every mutating
  // Server Action still calls `requireAllowedUser` for itself. Gating in the
  // middleware as well would only lock anonymous visitors out of public pages.
  //
  // The SDK response is still returned so session cookies keep refreshing for
  // signed-in owners.
  return authRes;
}

export const config = {
  matcher: [
    /*
     * Match all paths except Next.js internals and static files.
     */
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
