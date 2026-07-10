import type { CrawlCtx, RawJob, SourceAdapter } from "@jobscout/core";

const LEVER_BASE = "https://api.lever.co/v0/postings";

export const leverAdapter: SourceAdapter = {
  source: "lever",

  async fetchJobs(ctx: CrawlCtx): Promise<RawJob[]> {
    const results: RawJob[] = [];

    for (const company of ctx.companies) {
      if (!company.board_token) continue;
      const token = company.board_token;
      const url = `${LEVER_BASE}/${token}?mode=json`;

      let postings: Record<string, unknown>[];
      try {
        const res = await ctx.fetch(url);
        if (!res.ok) {
          ctx.recordError(
            `lever: ${token} postings returned HTTP ${res.status}`,
          );
          continue;
        }
        postings = (await res.json()) as Record<string, unknown>[];
      } catch (err) {
        ctx.recordError(
          `lever: ${token} postings failed: ${String(err)}`,
        );
        continue;
      }

      for (const posting of postings) {
        const categories = posting["categories"] as Record<string, unknown> | undefined;
        const createdAtMs = posting["createdAt"] as number | undefined;
        const postedAt =
          createdAtMs != null
            ? new Date(createdAtMs).toISOString()
            : undefined;

        results.push({
          source: "lever",
          externalId: String(posting["id"] ?? ""),
          url: String(posting["hostedUrl"] ?? ""),
          applyUrl: posting["applyUrl"] != null ? String(posting["applyUrl"]) : undefined,
          title: String(posting["text"] ?? ""),
          company: company.name,
          location: categories?.["location"] != null ? String(categories["location"]) : undefined,
          description: posting["descriptionPlain"] != null ? String(posting["descriptionPlain"]) : undefined,
          postedAt,
          atsHint: "lever",
          // Lever postings API does not expose application questions.
          questions: undefined,
          raw: posting,
        });
      }
    }

    return results;
  },
};
