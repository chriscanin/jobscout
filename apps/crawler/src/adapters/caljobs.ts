/**
 * CalJobs adapter — light HTML scraping of caljobs.ca.gov (Geographic Solutions portal).
 *
 * CalJobs is a public government job board without deliberate anti-bot hardening,
 * but it is an ASP.NET application that may require session cookies. We use a
 * simple GET-then-scrape approach: first GET establishes a session cookie, then
 * we issue keyword+location searches and parse the results table.
 *
 * external_id: the job order number (jbid param from the detail link, e.g. "CA-20240001")
 * Page cap: ≤ 3 search-result pages per run (CONTRACT §Politeness).
 * All HTTP goes through ctx.fetch (politeness + retry built in).
 */

import * as cheerio from "cheerio";
import type { CrawlCtx, RawJob, SourceAdapter } from "@jobscout/core";
import { isBlockedResponse } from "./blocked.js";

const BASE_URL = "https://www.caljobs.ca.gov";
const SEARCH_PATH = "/vosnet/jobbanks/jobsearch.aspx";
const MAX_PAGES = 3;

/** Extract the job order number from a CalJobs detail URL (jbid param). */
function extractJobOrderNum(href: string): string | null {
  try {
    // href may be relative: /vosnet/jobbanks/jobdetails.aspx?enc=...&jbid=CA-20240001
    const url = new URL(href, BASE_URL);
    const jbid = url.searchParams.get("jbid");
    if (jbid && jbid.length > 0) return jbid;
  } catch {
    // ignore malformed URLs
  }
  return null;
}

/** Parse one search-results page into RawJob records. Returns null if selector miss. */
function parsePage(html: string, source: "caljobs"): RawJob[] | null {
  const $ = cheerio.load(html);
  const rows = $("tr.gridViewRow");
  if (rows.length === 0) return null;

  const jobs: RawJob[] = [];
  rows.each((_i, el) => {
    const row = $(el);
    const titleAnchor = row.find("td.jobTitle a.jobTitleLink").first();
    const title = titleAnchor.text().trim();
    const href = titleAnchor.attr("href") ?? "";
    const company = row.find("td.employer").text().trim();
    const location = row.find("td.location").text().trim();
    const postedAt = row.find("td.postedDate").text().trim();
    const externalId = extractJobOrderNum(href);

    // Require all key fields; skip rows with missing data to avoid garbage
    if (!title || !company || !href || !externalId) return;

    const absoluteUrl = href.startsWith("http")
      ? href
      : `${BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`;

    jobs.push({
      source,
      externalId,
      url: absoluteUrl,
      title,
      company,
      location: location || undefined,
      postedAt: postedAt || undefined,
      raw: { href, location, postedAt },
    });
  });

  return jobs;
}

/** Extract the "Next" page URL from pagination block. Returns null if none. */
function nextPageUrl(html: string): string | null {
  const $ = cheerio.load(html);
  // Look for a pagination link whose text is "Next"
  const nextLink = $("div.pagination a.pageLink").filter((_i, el) => {
    return $(el).text().trim().toLowerCase() === "next";
  });
  if (nextLink.length === 0) return null;
  const href = nextLink.first().attr("href");
  if (!href) return null;
  return href.startsWith("http") ? href : `${BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`;
}

/** Build the initial search URL for given keywords. */
function buildSearchUrl(keywords: string[]): string {
  const q = keywords.join(" OR ");
  const url = new URL(SEARCH_PATH, BASE_URL);
  url.searchParams.set("q", q);
  url.searchParams.set("pg", "1");
  return url.toString();
}

export const caljobsAdapter: SourceAdapter = {
  source: "caljobs",

  async fetchJobs(ctx: CrawlCtx): Promise<RawJob[]> {
    // Collect all keywords from all role priorities
    const keywords = ctx.criteria.role_priorities.flatMap((rp) => rp.keywords);
    if (keywords.length === 0) keywords.push("software developer");

    const allJobs: RawJob[] = [];
    const seenIds = new Set<string>();
    let pagesFetched = 0;
    let currentUrl: string | null = buildSearchUrl(keywords);

    while (currentUrl && pagesFetched < MAX_PAGES) {
      let response: Response;
      try {
        response = await ctx.fetch(currentUrl);
      } catch (err) {
        ctx.logger.error(
          `caljobs: fetch error on page ${pagesFetched + 1}: ${String(err)}`,
        );
        break;
      }

      const body = await response.text();

      if (isBlockedResponse(response.status, body)) {
        ctx.logger.error(
          `caljobs: blocked response (status ${response.status}) on page ${pagesFetched + 1}`,
        );
        break;
      }

      if (!response.ok) {
        ctx.logger.error(
          `caljobs: unexpected status ${response.status} on page ${pagesFetched + 1}`,
        );
        break;
      }

      pagesFetched++;

      const jobs = parsePage(body, "caljobs");
      if (jobs === null) {
        ctx.logger.error(
          `caljobs: parse error — selectors missed on page ${pagesFetched} (layout may have changed)`,
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
