import { createHash } from "node:crypto";

/**
 * Normalize a field for dedup per CONTRACT §Database schema → jobs.dedup_hash:
 * lowercase, strip punctuation, collapse whitespace.
 */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * sha256 hex of the normalized `company | title | location` triple.
 * A null/undefined location normalizes to the empty string, so a job with no
 * location and a job with an explicitly empty location hash identically.
 */
export function dedupHash(
  company: string,
  title: string,
  location?: string | null,
): string {
  const parts = [
    normalize(company),
    normalize(title),
    normalize(location ?? ""),
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}
