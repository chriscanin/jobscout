import type { CrawlCtx, RawJob, SourceAdapter } from "@jobscout/core";

const WIDGET_BASE = "https://apply.workable.com/api/v1/widget/accounts";

export const workableAdapter: SourceAdapter = {
  source: "workable",

  async fetchJobs(ctx: CrawlCtx): Promise<RawJob[]> {
    const results: RawJob[] = [];

    for (const company of ctx.companies) {
      if (!company.board_token) continue;
      const token = company.board_token;
      // details=true includes the full HTML description in the single listing
      // call, so no per-job detail fetch is needed.
      const listUrl = `${WIDGET_BASE}/${token}?details=true`;

      let listData: { jobs?: Record<string, unknown>[] };
      try {
        const res = await ctx.fetch(listUrl);
        if (!res.ok) {
          ctx.recordError(
            `workable: ${token} listing returned HTTP ${res.status}`,
          );
          continue;
        }
        listData = (await res.json()) as { jobs?: Record<string, unknown>[] };
      } catch (err) {
        ctx.recordError(
          `workable: ${token} listing failed: ${String(err)}`,
        );
        continue;
      }

      const jobs = listData.jobs ?? [];

      for (const job of jobs) {
        const parts = [job["city"], job["state"], job["country"]]
          .map((p) => (p != null ? String(p) : ""))
          .filter((p) => p.length > 0);
        let location = parts.join(", ");
        if (!location && job["telecommuting"] === true) {
          location = "Remote";
        }

        results.push({
          source: "workable",
          externalId: String(job["shortcode"]),
          url: String(job["url"] ?? ""),
          applyUrl:
            job["application_url"] != null
              ? String(job["application_url"])
              : undefined,
          title: String(job["title"] ?? ""),
          company: company.name,
          location: location || undefined,
          description:
            job["description"] != null ? String(job["description"]) : undefined,
          postedAt:
            job["published_on"] != null
              ? String(job["published_on"])
              : undefined,
          atsHint: "workable",
          raw: job,
        });
      }
    }

    return results;
  },
};
