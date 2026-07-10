/**
 * ZipRecruiter adapter — light HTML scraping of ziprecruiter.com job search results.
 *
 * ZipRecruiter is heavily anti-bot protected (Cloudflare managed challenge). This
 * adapter is best-effort: on any run it may get nothing. It detects blocked
 * responses, records the error, returns [], and never crashes the run.
 *
 * external_id: the listing id embedded in the job URL path — the final path
 *   segment before any query string, e.g. for
 *   /jobs/acme-corp/senior-react-native-developer-j3n5v0680ctp58bvnbx
 *   the id is "j3n5v0680ctp58bvnbx" (the suffix after the last "-" in the slug).
 *
 * Page cap: ≤ 3 search-result pages per run (CONTRACT §Politeness).
 * All HTTP goes through ctx.fetch (politeness + retry built in).
 */

import * as cheerio from "cheerio";
import type { CrawlCtx, RawJob, SourceAdapter } from "@jobscout/core";
import { isBlockedResponse } from "./blocked.js";

const BASE_URL = "https://www.ziprecruiter.com";
const SEARCH_PATH = "/jobs-search";
const MAX_PAGES = 3;

/**
 * Extract the ZipRecruiter listing id from a job URL.
 *
 * ZipRecruiter job URLs follow the pattern:
 *   /jobs/<company-slug>/<title-slug>-<listingId>
 * or in some variants:
 *   /jobs/<company-slug>/<title-slug>-<listingId>?source=...
 *
 * The listing id is the last hyphen-separated token of the final path segment
 * (before any query string). It is alphanumeric with no slashes, question marks,
 * ampersands, or equals signs.
 */
export function extractListingId(jobUrl: string): string | null {
  try {
    const url = new URL(jobUrl, BASE_URL);
    // Take only the pathname, strip trailing slash
    const pathname = url.pathname.replace(/\/$/, "");
    // Final path segment
    const segment = pathname.split("/").pop();
    if (!segment) return null;
    // The listing id is the last hyphen-delimited token
    const parts = segment.split("-");
    const id = parts[parts.length - 1];
    // Must be non-empty and contain no URL-special characters
    if (id && /^[a-zA-Z0-9]+$/.test(id)) return id;
  } catch {
    // ignore malformed URLs
  }
  return null;
}

/** Parse one search-results page into RawJob records. Returns null on selector miss. */
function parsePage(html: string): RawJob[] | null {
  const $ = cheerio.load(html);

  // ZipRecruiter job cards: article.job_result_two_pane
  const articles = $("article.job_result_two_pane");
  if (articles.length === 0) return null;

  const jobs: RawJob[] = [];
  articles.each((_i, el) => {
    const article = $(el);

    // Job URL from the main job link
    const jobAnchor = article.find("a.job_link").first();
    const href = jobAnchor.attr("href") ?? "";
    const title = jobAnchor.find("h2.job_title").text().trim();

    // Absolute URL (strip query params for the canonical URL, keep path)
    let jobUrl = href;
    if (jobUrl && !jobUrl.startsWith("http")) {
      jobUrl = `${BASE_URL}${jobUrl.startsWith("/") ? "" : "/"}${jobUrl}`;
    }

    // Strip query string from the canonical URL stored in `url`
    let canonicalUrl = jobUrl;
    try {
      const u = new URL(jobUrl);
      canonicalUrl = `${u.origin}${u.pathname}`;
    } catch {
      // keep as-is
    }

    const externalId = extractListingId(jobUrl);
    const company = article.find("a.t_org_link.name").text().trim();
    const location = article.find("p.location span.city_state_zip").text().trim();
    const salaryRaw = article.find("p.salary").text().trim() || undefined;

    if (!title || !company || !externalId || !canonicalUrl) return;

    jobs.push({
      source: "ziprecruiter",
      externalId,
      url: canonicalUrl,
      title,
      company,
      location: location || undefined,
      salaryRaw,
      raw: { href, location, salaryRaw },
    });
  });

  return jobs;
}

/** Extract the "Next" page href from pagination. Returns null if none. */
function nextPageUrl(html: string): string | null {
  const $ = cheerio.load(html);
  const nextLink = $("nav.pagination a.next_page, a.next_page").first();
  if (nextLink.length === 0) return null;
  const href = nextLink.attr("href");
  if (!href) return null;
  return href.startsWith("http") ? href : `${BASE_URL}${href}`;
}

/** Build the initial search URL for given keywords and locations. */
function buildSearchUrl(keywords: string[], remoteUs: boolean): string {
  const q = keywords.join(" ");
  const url = new URL(SEARCH_PATH, BASE_URL);
  url.searchParams.set("search", q);
  if (remoteUs) {
    url.searchParams.set("location", "Remote");
  }
  return url.toString();
}

export const ziprecruiterAdapter: SourceAdapter = {
  source: "ziprecruiter",

  async fetchJobs(ctx: CrawlCtx): Promise<RawJob[]> {
    const keywords = ctx.criteria.role_priorities.flatMap((rp) => rp.keywords);
    if (keywords.length === 0) keywords.push("software developer");

    const remoteUs = ctx.criteria.locations.remote_us ?? false;
    const allJobs: RawJob[] = [];
    const seenIds = new Set<string>();
    let pagesFetched = 0;
    let currentUrl: string | null = buildSearchUrl(keywords, remoteUs);

    while (currentUrl && pagesFetched < MAX_PAGES) {
      let response: Response;
      try {
        response = await ctx.fetch(currentUrl);
      } catch (err) {
        ctx.logger.error(
          `ziprecruiter: fetch error on page ${pagesFetched + 1}: ${String(err)}`,
        );
        break;
      }

      const body = await response.text();

      if (isBlockedResponse(response.status, body)) {
        ctx.logger.error(
          `ziprecruiter: blocked response (status ${response.status}) — ziprecruiter blocked this request`,
        );
        // Stop immediately — no retries, no alternate endpoints
        break;
      }

      if (!response.ok) {
        ctx.logger.error(
          `ziprecruiter: unexpected status ${response.status} on page ${pagesFetched + 1}`,
        );
        break;
      }

      pagesFetched++;

      const jobs = parsePage(body);
      if (jobs === null) {
        ctx.logger.error(
          `ziprecruiter: parse error — selectors missed on page ${pagesFetched} (layout may have changed)`,
        );
        break;
      }

      for (const job of jobs) {
        if (!seenIds.has(job.externalId)) {
          seenIds.add(job.externalId);
          allJobs.push(job);
        }
      }

      currentUrl = pagesFetched < MAX_PAGES ? nextPageUrl(body) : null;
    }

    return allJobs;
  },
};
