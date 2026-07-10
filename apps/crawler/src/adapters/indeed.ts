/**
 * Indeed adapter — light HTML scraping of indeed.com job search results.
 *
 * Indeed is heavily anti-bot protected (Cloudflare managed challenge). This
 * adapter is best-effort: on any run it may get nothing. It detects blocked
 * responses, records the error, returns [], and never crashes the run.
 *
 * external_id: the `jk` query parameter from the job link (tracking params discarded).
 * canonical url: https://www.indeed.com/viewjob?jk=<externalId>
 * Page cap: ≤ 3 search-result pages per run (CONTRACT §Politeness).
 * All HTTP goes through ctx.fetch (politeness + retry built in).
 */

import * as cheerio from "cheerio";
import type { CrawlCtx, RawJob, SourceAdapter } from "@jobscout/core";
import { isBlockedResponse } from "./blocked.js";

const BASE_URL = "https://www.indeed.com";
const SEARCH_PATH = "/jobs";
const MAX_PAGES = 3;

/** Extract the `jk` value from a job link href, discarding all other params. */
function extractJk(href: string): string | null {
  try {
    const url = new URL(href, BASE_URL);
    const jk = url.searchParams.get("jk");
    if (jk && jk.length > 0) return jk;
  } catch {
    // ignore malformed URLs
  }
  return null;
}

/** Parse one search-results page into RawJob records. Returns null on selector miss. */
function parsePage(html: string): RawJob[] | null {
  const $ = cheerio.load(html);

  // Indeed job cards: articles with data-jk attribute inside the results list
  const articles = $("article[data-jk]");
  if (articles.length === 0) return null;

  const jobs: RawJob[] = [];
  articles.each((_i, el) => {
    const article = $(el);
    const jk = article.attr("data-jk");
    if (!jk) return;

    // Title: span inside the job title anchor
    const titleEl = article.find("h2.jobTitle a span[title], h2.jobTitle a span").first();
    const title = titleEl.attr("title") ?? titleEl.text().trim();

    // Company name
    const company = article.find("[data-testid='company-name']").text().trim();

    // Location
    const location = article.find("[data-testid='text-location']").text().trim();

    // Salary (optional)
    const salaryRaw = article.find(".estimated-salary, .salary-snippet").text().trim() || undefined;

    if (!title || !company || !jk) return;

    const url = `${BASE_URL}/viewjob?jk=${jk}`;

    jobs.push({
      source: "indeed",
      externalId: jk,
      url,
      title,
      company,
      location: location || undefined,
      salaryRaw,
      raw: { jk, location, salaryRaw },
    });
  });

  return jobs;
}

/** Extract the "Next Page" href from pagination. Returns null if none. */
function nextPageUrl(html: string): string | null {
  const $ = cheerio.load(html);
  const nextLink = $("a[aria-label='Next Page']").first();
  if (nextLink.length === 0) return null;
  const href = nextLink.attr("href");
  if (!href) return null;
  return href.startsWith("http") ? href : `${BASE_URL}${href}`;
}

/** Build the initial search URL for given keywords and locations. */
function buildSearchUrl(keywords: string[], remoteUs: boolean): string {
  const q = keywords.join(" ");
  const url = new URL(SEARCH_PATH, BASE_URL);
  url.searchParams.set("q", q);
  if (remoteUs) {
    url.searchParams.set("l", "remote");
    // remotejob param for Indeed's remote filter
    url.searchParams.set("remotejob", "032b3046-06a3-4876-8dfd-474eb5e7ed11");
  }
  return url.toString();
}

export const indeedAdapter: SourceAdapter = {
  source: "indeed",

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
          `indeed: fetch error on page ${pagesFetched + 1}: ${String(err)}`,
        );
        break;
      }

      const body = await response.text();

      if (isBlockedResponse(response.status, body)) {
        const isChallenge = response.status === 200;
        if (isChallenge) {
          ctx.logger.error(
            `indeed: challenge page detected (status 200 with challenge markers)`,
          );
        } else {
          ctx.logger.error(
            `indeed: blocked response (status ${response.status}) — indeed blocked this request`,
          );
        }
        // Stop immediately — no retries, no alternate endpoints
        break;
      }

      if (!response.ok) {
        ctx.logger.error(
          `indeed: unexpected status ${response.status} on page ${pagesFetched + 1}`,
        );
        break;
      }

      pagesFetched++;

      const jobs = parsePage(body);
      if (jobs === null) {
        ctx.logger.error(
          `indeed: parse error — selectors missed on page ${pagesFetched} (layout may have changed)`,
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

export { extractJk };
