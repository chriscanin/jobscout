import type { CrawlCtx, RawJob, SourceAdapter } from "@jobscout/core";

const API_BASE = "https://api.smartrecruiters.com/v1/companies";
const JOBS_BASE = "https://jobs.smartrecruiters.com";
const PAGE_SIZE = 100;
const MAX_PAGES = 5;

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

/** The posting `location` object shape (list and detail share it). */
interface PostingLocation {
  city?: string;
  region?: string;
  country?: string;
  remote?: boolean;
  fullLocation?: string;
}

/** Build the location string: fullLocation (fallback city/country join), with " (Remote)" appended when remote and not already stated. */
function buildLocation(location: PostingLocation | undefined): string | undefined {
  if (!location) return undefined;
  const base =
    location.fullLocation ??
    [location.city, location.country].filter(Boolean).join(", ");
  if (location.remote === true) {
    if (!base) return "Remote";
    if (!base.toLowerCase().includes("remote")) return `${base} (Remote)`;
  }
  return base || undefined;
}

/** Join the detail payload's jobAd section texts into one description. */
function sectionsToDescription(
  merged: Record<string, unknown>,
): string | undefined {
  const jobAd = merged["jobAd"] as
    | { sections?: Record<string, { title?: string; text?: string }> }
    | undefined;
  const sections = jobAd?.sections;
  if (!sections) return undefined;
  const texts = [
    "companyDescription",
    "jobDescription",
    "qualifications",
    "additionalInformation",
  ]
    .map((key) => sections[key]?.text)
    .filter((t): t is string => typeof t === "string" && t.length > 0);
  return texts.length > 0 ? texts.join("\n\n") : undefined;
}

export const smartrecruitersAdapter: SourceAdapter = {
  source: "smartrecruiters",

  async fetchJobs(ctx: CrawlCtx): Promise<RawJob[]> {
    const keywords = allKeywords(ctx);
    const results: RawJob[] = [];

    for (const company of ctx.companies) {
      if (!company.board_token) continue;
      const token = company.board_token;

      // Paginate the listing: offset += 100 while collected < totalFound,
      // capped at MAX_PAGES pages per company for safety.
      const postings: Record<string, unknown>[] = [];
      let offset = 0;

      for (let page = 0; page < MAX_PAGES; page++) {
        const listUrl = `${API_BASE}/${token}/postings?limit=${PAGE_SIZE}&offset=${offset}`;

        let listData: { totalFound?: number; content?: Record<string, unknown>[] };
        try {
          const res = await ctx.fetch(listUrl);
          if (!res.ok) {
            ctx.recordError(
              `smartrecruiters: ${token} listing returned HTTP ${res.status}`,
            );
            break;
          }
          listData = (await res.json()) as {
            totalFound?: number;
            content?: Record<string, unknown>[];
          };
        } catch (err) {
          ctx.recordError(
            `smartrecruiters: ${token} listing failed: ${String(err)}`,
          );
          break;
        }

        const content = listData.content ?? [];
        postings.push(...content);

        const totalFound = Number(listData.totalFound ?? postings.length);
        if (content.length === 0 || postings.length >= totalFound) break;
        offset += PAGE_SIZE;
      }

      for (const posting of postings) {
        const postingId = String(posting["id"]);
        const title = String(posting["name"] ?? "");

        let merged: Record<string, unknown> = { ...posting };

        // Prescreen: only fetch detail for title-matching jobs.
        if (passesPrescreen(title, keywords)) {
          const detailUrl = `${API_BASE}/${token}/postings/${postingId}`;
          try {
            const detailRes = await ctx.fetch(detailUrl);
            if (detailRes.ok) {
              const detail = (await detailRes.json()) as Record<string, unknown>;
              // Merge detail into listing — detail fields win.
              merged = { ...posting, ...detail };
            } else {
              ctx.logger.warn(
                `smartrecruiters: detail fetch for ${postingId} returned HTTP ${detailRes.status}`,
              );
            }
          } catch (err) {
            ctx.logger.warn(
              `smartrecruiters: detail fetch for ${postingId} failed: ${String(err)}`,
            );
          }
        }

        const location = merged["location"] as PostingLocation | undefined;

        results.push({
          source: "smartrecruiters",
          externalId: postingId,
          url:
            merged["postingUrl"] != null
              ? String(merged["postingUrl"])
              : `${JOBS_BASE}/${token}/${postingId}`,
          applyUrl:
            merged["applyUrl"] != null ? String(merged["applyUrl"]) : undefined,
          title,
          company: company.name,
          location: buildLocation(location),
          description: sectionsToDescription(merged),
          postedAt:
            posting["releasedDate"] != null
              ? String(posting["releasedDate"])
              : undefined,
          atsHint: "smartrecruiters",
          raw: merged,
        });
      }
    }

    return results;
  },
};
