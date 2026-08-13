/**
 * HN "Who is hiring" adapter — Algolia HN Search API.
 *
 * Two-step flow: find the newest monthly "Ask HN: Who is hiring?" thread via
 * the Algolia search endpoint, then fetch the thread's items payload and emit
 * one RawJob per top-level comment with non-empty text. Nested replies are
 * ignored (and stripped from `raw` to avoid bloat).
 *
 * external_id: the comment id (stable across runs; dedup happens downstream
 * on (source, externalId)).
 *
 * This is a search-style source: ctx.companies is ignored.
 * All HTTP goes through ctx.fetch (politeness + retry built in).
 */

import type { CrawlCtx, RawJob, SourceAdapter } from "@jobscout/core";

const SEARCH_URL =
  "https://hn.algolia.com/api/v1/search_by_date?query=%22who%20is%20hiring%22&tags=story,author_whoishiring";
const ITEM_BASE = "https://hn.algolia.com/api/v1/items";
const THREAD_TITLE_RE = /^Ask HN: Who is hiring\?/;

const TITLE_MAX = 140;
const COMPANY_MAX = 80;

/**
 * HTML comment text → plain-text lines: paragraph/line breaks become newlines,
 * remaining tags are stripped, and the entities Algolia emits are decoded.
 */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<p[^>]*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x2F;/g, "/")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

/** First non-empty line of the HTML-stripped comment text. */
function firstLine(html: string): string {
  const line = htmlToPlainText(html)
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? "";
}

export const hnAdapter: SourceAdapter = {
  source: "hn",

  async fetchJobs(ctx: CrawlCtx): Promise<RawJob[]> {
    // Step 1: locate the newest "Ask HN: Who is hiring?" thread.
    let hits: Record<string, unknown>[];
    try {
      const res = await ctx.fetch(SEARCH_URL);
      if (!res.ok) {
        ctx.recordError(`hn: thread search returned HTTP ${res.status}`);
        return [];
      }
      const data = (await res.json()) as { hits?: Record<string, unknown>[] };
      hits = data.hits ?? [];
    } catch (err) {
      ctx.recordError(`hn: thread search failed: ${String(err)}`);
      return [];
    }

    const matching = hits
      .filter((h) => THREAD_TITLE_RE.test(String(h["title"] ?? "")))
      .sort((a, b) =>
        String(b["created_at"] ?? "").localeCompare(String(a["created_at"] ?? "")),
      );

    const thread = matching[0];
    if (!thread) {
      ctx.recordError('hn: no "Ask HN: Who is hiring?" thread found');
      return [];
    }

    // Step 2: fetch the thread items (top-level comments are the postings).
    const threadId = String(thread["objectID"]);
    let children: Record<string, unknown>[];
    try {
      const res = await ctx.fetch(`${ITEM_BASE}/${threadId}`);
      if (!res.ok) {
        ctx.recordError(`hn: thread ${threadId} fetch returned HTTP ${res.status}`);
        return [];
      }
      const data = (await res.json()) as { children?: Record<string, unknown>[] };
      children = data.children ?? [];
    } catch (err) {
      ctx.recordError(`hn: thread ${threadId} fetch failed: ${String(err)}`);
      return [];
    }

    const results: RawJob[] = [];

    for (const child of children) {
      const text = child["text"];
      // Deleted comments have null text; skip empties too.
      if (typeof text !== "string" || text.trim().length === 0) continue;

      const id = String(child["id"]);
      const line = firstLine(text);
      const title = line.slice(0, TITLE_MAX);
      const companySegment = line.split("|")[0].trim().slice(0, COMPANY_MAX);
      const company = companySegment || String(child["author"] ?? "");

      // Drop nested replies from raw to avoid bloat.
      const { children: _replies, ...rawChild } = child;

      results.push({
        source: "hn",
        externalId: id,
        url: `https://news.ycombinator.com/item?id=${id}`,
        title,
        company,
        description: text,
        postedAt: child["created_at"] != null ? String(child["created_at"]) : undefined,
        raw: rawChild,
      });
    }

    return results;
  },
};
