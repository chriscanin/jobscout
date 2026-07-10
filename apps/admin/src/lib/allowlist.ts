/**
 * Email allowlist helper (CONTRACT §Environment variables: ADMIN_ALLOWED_EMAILS).
 * Parses a comma-separated list of email addresses and checks membership.
 * Case-insensitive, trims whitespace around each entry.
 */
export function isAllowed(email: string, csv: string): boolean {
  if (!csv.trim()) return false;
  const allowed = csv
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(email.trim().toLowerCase());
}
