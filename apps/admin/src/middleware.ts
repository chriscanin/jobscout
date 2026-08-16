/**
 * The board is public. Nothing here gates anything.
 *
 * This app started life as a private admin panel behind Auth0, and later a
 * password gate. Both are gone: it is a job board, and a job board that asks
 * for a password is not much of a job board.
 *
 * The auth helpers in `lib/` are deliberately left in place, unused, so the gate
 * can be reinstated by calling `requireAllowedUser()` at the top of a page or
 * Server Action again. Nothing else would need to change.
 *
 * The Auth0 SDK middleware still runs when a tenant is configured, purely so its
 * /auth/* routes stay mounted. It is wrapped because an unconfigured or
 * half-configured tenant throws on client construction, and a 500 on every
 * request is a much worse failure than no auth routes.
 */
import { type NextRequest, NextResponse } from "next/server";
import { getAuth0Client } from "./lib/auth0";
import { passwordAuthEnabled } from "./lib/password-auth";

export async function middleware(request: NextRequest) {
  if (passwordAuthEnabled()) {
    return NextResponse.next();
  }

  if (!process.env.AUTH0_DOMAIN) {
    return NextResponse.next();
  }

  try {
    const authRes = await getAuth0Client().middleware(request);
    return authRes ?? NextResponse.next();
  } catch {
    return NextResponse.next();
  }
}

export const config = {
  matcher: [
    /*
     * Match all paths except Next.js internals and static files.
     */
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
