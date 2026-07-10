/**
 * Auth0 client singleton for @auth0/nextjs-auth0 v4.
 *
 * v4 requires these env vars at runtime (read lazily — not at module load —
 * so `next build` succeeds with no env vars present):
 *   AUTH0_DOMAIN          — e.g. dev-xxxx.us.auth0.com
 *   AUTH0_CLIENT_ID
 *   AUTH0_CLIENT_SECRET
 *   AUTH0_SECRET          — random 32+ char session encryption key
 *   APP_BASE_URL          — e.g. https://jobscout-admin.vercel.app
 *
 * In v4, authentication routes (/auth/login, /auth/callback, /auth/logout)
 * are mounted automatically by the middleware — no separate route handler
 * is required (though `auth0.handler` is exported for use in route.ts).
 */
import { Auth0Client } from "@auth0/nextjs-auth0/server";

let _auth0: Auth0Client | null = null;

export function getAuth0Client(): Auth0Client {
  if (_auth0) return _auth0;
  _auth0 = new Auth0Client();
  return _auth0;
}

// Convenience export used by the catch-all route handler and middleware
export const auth0 = {
  get client() {
    return getAuth0Client();
  },
};
