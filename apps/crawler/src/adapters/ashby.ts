import type { CrawlCtx, RawJob, SourceAdapter } from "@jobscout/core";

const ASHBY_BASE = "https://api.ashbyhq.com/posting-api/job-board";

export const ashbyAdapter: SourceAdapter = {
  source: "ashby",

  async fetchJobs(ctx: CrawlCtx): Promise<RawJob[]> {
    const results: RawJob[] = [];

    for (const company of ctx.companies) {
      if (!company.board_token) continue;
      const token = company.board_token;
      const url = `${ASHBY_BASE}/${token}`;

      let boardData: { jobs: Record<string, unknown>[] };
      try {
        const res = await ctx.fetch(url);
        if (!res.ok) {
          ctx.recordError(
            `ashby: ${token} board returned HTTP ${res.status}`,
          );
          continue;
        }
        const text = await res.text();
        try {
          boardData = JSON.parse(text) as { jobs: Record<string, unknown>[] };
        } catch {
          ctx.recordError(
            `ashby: ${token} board returned non-JSON response`,
          );
          continue;
        }
      } catch (err) {
        ctx.recordError(
          `ashby: ${token} board fetch failed: ${String(err)}`,
        );
        continue;
      }

      const jobs = boardData.jobs ?? [];

      for (const job of jobs) {
        results.push({
          source: "ashby",
          externalId: String(job["id"] ?? ""),
          url: String(job["jobUrl"] ?? ""),
          applyUrl: job["applyUrl"] != null ? String(job["applyUrl"]) : undefined,
          title: String(job["title"] ?? ""),
          company: company.name,
          location: job["location"] != null ? String(job["location"]) : undefined,
          description: job["descriptionHtml"] != null ? String(job["descriptionHtml"]) : undefined,
          postedAt: job["publishedAt"] != null ? String(job["publishedAt"]) : undefined,
          atsHint: "ashby",
          // Ashby job-board API does not expose application questions.
          questions: undefined,
          raw: job,
        });
      }
    }

    return results;
  },
};
