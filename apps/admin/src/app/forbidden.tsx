/**
 * 403 page (spec 08 §3 S2).
 *
 * Rendered by Next.js when `forbidden()` is called (see `requireAllowedUser`
 * in `src/lib/auth.ts`). Serving this file carries an HTTP 403 status.
 * The body must contain the text "Not authorized".
 */
export default function Forbidden() {
  return (
    <div className="rise">
      <p className="kicker">403</p>
      <h1>Not authorized</h1>
      <p className="lede">
        Not authorized — your account is not on the admin allowlist.
      </p>
    </div>
  );
}
