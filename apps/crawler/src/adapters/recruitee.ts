import type { CrawlCtx, RawJob, SourceAdapter } from "@jobscout/core";

/**
 * Convert Recruitee's "2026-07-28 07:42:48 UTC" timestamps to ISO 8601
 * ("2026-07-28T07:42:48Z"). Returns undefined if the result does not parse.
 */
function toIso(publishedAt: unknown): string | undefined {
  if (publishedAt == null) return undefined;
  const iso = String(publishedAt).replace(" ", "T").replace(" UTC", "Z");
  return Number.isNaN(Date.parse(iso)) ? undefined : iso;
}

export const recruiteeAdapter: SourceAdapter = {
  source: "recruitee",

  async fetchJobs(ctx: CrawlCtx): Promise<RawJob[]> {
    const results: RawJob[] = [];

    for (const company of ctx.companies) {
      if (!company.board_token) continue;
      const token = company.board_token;
      const listUrl = `https://${token}.recruitee.com/api/offers/`;

      let listData: { offers?: Record<string, unknown>[] };
      try {
        const res = await ctx.fetch(listUrl);
        if (!res.ok) {
          ctx.recordError(
            `recruitee: ${token} listing returned HTTP ${res.status}`,
          );
          continue;
        }
        listData = (await res.json()) as { offers?: Record<string, unknown>[] };
      } catch (err) {
        ctx.recordError(
          `recruitee: ${token} listing failed: ${String(err)}`,
        );
        continue;
      }

      const offers = listData.offers ?? [];

      for (const offer of offers) {
        const descriptionHtml =
          offer["description"] != null ? String(offer["description"]) : "";
        const requirementsHtml =
          offer["requirements"] != null ? String(offer["requirements"]) : "";
        const description = requirementsHtml
          ? `${descriptionHtml}\n\n${requirementsHtml}`
          : descriptionHtml;

        let location =
          offer["location"] != null ? String(offer["location"]) : "";
        if (!location && offer["remote"] === true) {
          location = "Remote";
        }

        results.push({
          source: "recruitee",
          externalId: String(offer["id"]),
          url: String(offer["careers_url"] ?? ""),
          applyUrl:
            offer["careers_apply_url"] != null
              ? String(offer["careers_apply_url"])
              : undefined,
          title: String(offer["title"] ?? ""),
          company: company.name,
          location: location || undefined,
          description: description || undefined,
          postedAt: toIso(offer["published_at"]),
          atsHint: "recruitee",
          raw: offer,
        });
      }
    }

    return results;
  },
};
