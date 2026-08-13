/**
 * Remotive adapter — public JSON API at https://remotive.com/api/remote-jobs.
 *
 * We query the software-dev category only. NOTE: Remotive's ToS asks for
 * roughly 4 fetches per day and delays job publication by 24h — this adapter
 * issues exactly one light GET per crawl cycle, which is well within that.
 *
 * external_id: the Remotive job id.
 * This is a search-style source: ctx.companies is ignored.
 * All HTTP goes through ctx.fetch (politeness + retry built in).
 */

import type { CrawlCtx, RawJob, SourceAdapter } from "@jobscout/core";

const API_URL = "https://remotive.com/api/remote-jobs?category=software-dev";

export const remotiveAdapter: SourceAdapter = {
  source: "remotive",

  async fetchJobs(ctx: CrawlCtx): Promise<RawJob[]> {
    let jobs: Record<string, unknown>[];
    try {
      const res = await ctx.fetch(API_URL);
      if (!res.ok) {
        ctx.recordError(`remotive: API returned HTTP ${res.status}`);
        return [];
      }
      const data = (await res.json()) as { jobs?: Record<string, unknown>[] };
      jobs = data.jobs ?? [];
    } catch (err) {
      ctx.recordError(`remotive: API fetch failed: ${String(err)}`);
      return [];
    }

    const results: RawJob[] = [];

    for (const job of jobs) {
      if (job === null || typeof job !== "object" || job["id"] == null) continue;

      const salary = String(job["salary"] ?? "");

      results.push({
        source: "remotive",
        externalId: String(job["id"]),
        url: String(job["url"] ?? ""),
        title: String(job["title"] ?? ""),
        company: String(job["company_name"] ?? ""),
        location:
          job["candidate_required_location"] != null
            ? String(job["candidate_required_location"])
            : undefined,
        salaryRaw: salary || undefined,
        description: job["description"] != null ? String(job["description"]) : undefined,
        postedAt:
          job["publication_date"] != null ? String(job["publication_date"]) : undefined,
        raw: job,
      });
    }

    return results;
  },
};
