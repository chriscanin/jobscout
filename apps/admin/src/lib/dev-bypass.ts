/**
 * Local-only auth bypass.
 *
 * The app is designed to run behind Auth0 (deployed on Vercel), but the
 * primary deployment today is localhost against local Postgres, where no
 * Auth0 tenant exists. Setting DEV_FAKE_SESSION_EMAIL in .env.local treats
 * that email as the logged-in user — the ADMIN_ALLOWED_EMAILS allowlist is
 * STILL enforced by requireAllowedUser.
 *
 * Two conditions must hold, so this can never fire on a real deployment:
 *   1. DEV_FAKE_SESSION_EMAIL is set (never set it in Vercel env vars), AND
 *   2. APP_BASE_URL starts with http://localhost (deployed apps are https).
 */
export function devBypassEmail(): string | null {
  const email = process.env.DEV_FAKE_SESSION_EMAIL;
  const base = process.env.APP_BASE_URL ?? "";
  if (email && email.trim() !== "" && base.startsWith("http://localhost")) {
    return email.trim();
  }
  return null;
}
