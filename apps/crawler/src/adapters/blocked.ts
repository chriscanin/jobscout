/**
 * Shared blocked-response detection for scraped adapters.
 *
 * Returns true when the response looks like an anti-bot challenge or block:
 *   - HTTP 403 or 429
 *   - Body contains known challenge markers (Cloudflare, hCaptcha, PerimeterX)
 *
 * The marker list is derived from the real blocked fixtures captured for
 * Indeed (blocked-403.html) and ZipRecruiter (blocked-429.html).
 * Never attempt bypass — just detect and report.
 */

const CHALLENGE_MARKERS = [
  "captcha",
  "hcaptcha",
  "cf-chl",
  "Just a moment",
  "px-captcha",
  "Enable JavaScript and cookies to continue",
  "Security Check",
  "challenge-platform",
] as const;

export function isBlockedResponse(status: number, body: string): boolean {
  if (status === 403 || status === 429) return true;
  const lower = body.toLowerCase();
  for (const marker of CHALLENGE_MARKERS) {
    if (lower.includes(marker.toLowerCase())) return true;
  }
  return false;
}
