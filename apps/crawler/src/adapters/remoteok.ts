/**
 * RemoteOK adapter — public JSON API at https://remoteok.com/api.
 *
 * The base API only returns the ~100 newest posts across all tags, so the
 * mobile roles this project prioritizes scroll out fast. We therefore also
 * query the tag-filtered endpoints for each mobile tag (verified live:
 * `/api?tag=react-native` returns older still-open RN posts) and dedup by id
 * within the run.
 *
 * Each response is a JSON array whose first element is a legal-notice object
 * (it has a "legal" key) — that element is skipped. Every other element is a
 * job posting. salary_min/salary_max come back as STRINGS ("0" when absent);
 * we fold them into `salaryRaw` since RawJob has no numeric salary fields.
 *
 * external_id: the RemoteOK job id.
 * This is a search-style source: ctx.companies is ignored.
 * All HTTP goes through ctx.fetch (politeness + retry built in).
 */

import type { CrawlCtx, RawJob, SourceAdapter } from "@jobscout/core";

const API_URL = "https://remoteok.com/api";

/** Tag-filtered queries fetched in addition to the base feed. */
const MOBILE_TAGS = ["react-native", "mobile", "ios", "android", "flutter"];

const API_URLS = [API_URL, ...MOBILE_TAGS.map((t) => `${API_URL}?tag=${t}`)];

/** Parse a RemoteOK salary string; returns undefined for "0"/absent/NaN. */
function parseSalary(value: unknown): number | undefined {
  const n = parseInt(String(value ?? ""), 10);
  return Number.isNaN(n) || n === 0 ? undefined : n;
}

/** Build the salaryRaw string from the API's string salary fields. */
function salaryRaw(entry: Record<string, unknown>): string | undefined {
  const min = parseSalary(entry["salary_min"]);
  if (min === undefined) return undefined;
  const max = parseSalary(entry["salary_max"]);
  return max !== undefined ? `${min}-${max} USD` : `${min} USD`;
}

export const remoteokAdapter: SourceAdapter = {
  source: "remoteok",

  async fetchJobs(ctx: CrawlCtx): Promise<RawJob[]> {
    const results: RawJob[] = [];
    const seen = new Set<string>();

    for (const url of API_URLS) {
      let entries: unknown[];
      try {
        const res = await ctx.fetch(url);
        if (!res.ok) {
          ctx.recordError(`remoteok: ${url} returned HTTP ${res.status}`);
          continue;
        }
        const data = (await res.json()) as unknown;
        if (!Array.isArray(data)) {
          ctx.recordError(`remoteok: ${url} response is not an array`);
          continue;
        }
        entries = data;
      } catch (err) {
        ctx.recordError(`remoteok: ${url} fetch failed: ${String(err)}`);
        continue;
      }

      for (const entry of entries) {
        if (entry === null || typeof entry !== "object") continue;
        const job = entry as Record<string, unknown>;
        // The first element is a legal-notice object, not a job.
        if ("legal" in job) continue;
        if (job["id"] == null) continue;

        const id = String(job["id"]);
        if (seen.has(id)) continue;
        seen.add(id);

        const location = String(job["location"] ?? "");

        results.push({
          source: "remoteok",
          externalId: id,
          url: String(job["url"] ?? ""),
          applyUrl: job["apply_url"] != null ? String(job["apply_url"]) : undefined,
          title: String(job["position"] ?? ""),
          company: String(job["company"] ?? ""),
          location: location || undefined,
          salaryRaw: salaryRaw(job),
          description: job["description"] != null ? String(job["description"]) : undefined,
          postedAt: job["date"] != null ? String(job["date"]) : undefined,
          raw: job,
        });
      }
    }

    return results;
  },
};
