import type { CrawlCtx, RawJob, SourceAdapter } from "@jobscout/core";

const BOARD_BASE = "https://boards-api.greenhouse.io/v1/boards";

/** All keyword strings from criteria, flattened and lowercased. */
function allKeywords(ctx: CrawlCtx): string[] {
  return ctx.criteria.role_priorities.flatMap((rp) =>
    rp.keywords.map((k) => k.toLowerCase()),
  );
}

/** True if the job title contains at least one criteria keyword. */
function passesPrescreen(title: string, keywords: string[]): boolean {
  const lower = title.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

export const greenhouseAdapter: SourceAdapter = {
  source: "greenhouse",

  async fetchJobs(ctx: CrawlCtx): Promise<RawJob[]> {
    const keywords = allKeywords(ctx);
    const results: RawJob[] = [];

    for (const company of ctx.companies) {
      if (!company.board_token) continue;
      const token = company.board_token;
      const listUrl = `${BOARD_BASE}/${token}/jobs?content=true`;

      let listData: { jobs: Record<string, unknown>[] };
      try {
        const res = await ctx.fetch(listUrl);
        if (!res.ok) {
          ctx.recordError(
            `greenhouse: ${token} listing returned HTTP ${res.status}`,
          );
          continue;
        }
        listData = (await res.json()) as { jobs: Record<string, unknown>[] };
      } catch (err) {
        ctx.recordError(
          `greenhouse: ${token} listing failed: ${String(err)}`,
        );
        continue;
      }

      const jobs = listData.jobs ?? [];

      for (const job of jobs) {
        const jobId = String(job["id"]);
        const title = String(job["title"] ?? "");

        let merged: Record<string, unknown> = { ...job };

        // Prescreen: only fetch detail for title-matching jobs.
        if (passesPrescreen(title, keywords)) {
          const detailUrl = `${BOARD_BASE}/${token}/jobs/${jobId}?questions=true`;
          try {
            const detailRes = await ctx.fetch(detailUrl);
            if (detailRes.ok) {
              const detail = (await detailRes.json()) as Record<string, unknown>;
              // Merge detail into listing — detail fields win.
              merged = { ...job, ...detail };
            } else {
              ctx.logger.warn(
                `greenhouse: detail fetch for ${jobId} returned HTTP ${detailRes.status}`,
              );
            }
          } catch (err) {
            ctx.logger.warn(
              `greenhouse: detail fetch for ${jobId} failed: ${String(err)}`,
            );
          }
        }

        const locationObj = job["location"] as { name?: string } | undefined;
        const questions = merged["questions"] as unknown[] | undefined;

        results.push({
          source: "greenhouse",
          externalId: jobId,
          url: String(job["absolute_url"] ?? ""),
          applyUrl: String(job["absolute_url"] ?? ""),
          title,
          company: company.name,
          location: locationObj?.name,
          description: merged["content"] != null ? String(merged["content"]) : undefined,
          postedAt: job["first_published"] != null ? String(job["first_published"]) : undefined,
          atsHint: "greenhouse",
          questions: questions,
          raw: merged,
        });
      }
    }

    return results;
  },
};
