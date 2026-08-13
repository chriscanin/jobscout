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
import {
  isValidToken,
  passwordAuthEnabled,
  SESSION_COOKIE,
} from "./lib/password-auth";

export async function middleware(request: NextRequest) {
  // Local-only bypass (see lib/dev-bypass.ts): skip the Auth0 middleware —
  // pages still enforce the allowlist via requireAllowedUser.
  if (devBypassEmail()) {
    return NextResponse.next();
  }

  // Password-gate mode: no Auth0 tenant required.
  if (passwordAuthEnabled()) {
    const path = request.nextUrl.pathname;
    // Allow the login page and its POST through unconditionally.
    if (path === "/login") {
      return NextResponse.next();
    }
    const token = request.cookies.get(SESSION_COOKIE)?.value;
    if (await isValidToken(token)) {
      return NextResponse.next();
    }
    const loginUrl = new URL("/login", request.nextUrl.origin);
    loginUrl.searchParams.set(
      "returnTo",
      request.nextUrl.pathname + request.nextUrl.search,
    );
    return NextResponse.redirect(loginUrl);
  }

  const auth0 = getAuth0Client();
  const authRes = await auth0.middleware(request);

  // /auth/* routes are owned by the SDK middleware — return its response directly
  if (request.nextUrl.pathname.startsWith("/auth")) {
    return authRes;
  }

  // For all other routes, require an active session
  const session = await auth0.getSession(request);
  if (!session) {
    const loginUrl = new URL("/auth/login", request.nextUrl.origin);
    loginUrl.searchParams.set(
      "returnTo",
      request.nextUrl.pathname + request.nextUrl.search,
    );
    return NextResponse.redirect(loginUrl);
  }

  // Return the SDK's response (carries cookie refresh headers)
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
