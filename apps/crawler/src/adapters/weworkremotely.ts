/**
 * We Work Remotely adapter — RSS 2.0 feed of the remote-programming-jobs
 * category (~25 items per fetch).
 *
 * Item titles come as "Company: Role"; we split on the first ": " to recover
 * both fields. The feed's non-standard <region> element carries the location.
 * Parsed with a small local regex-based parser (same house style as
 * parseRssItems in sources.ts, plus <region>/<guid>/<pubDate> handling).
 *
 * external_id: the item <guid> (falls back to <link>).
 * This is a search-style source: ctx.companies is ignored.
 * All HTTP goes through ctx.fetch (politeness + retry built in).
 */

import type { CrawlCtx, RawJob, SourceAdapter } from "@jobscout/core";

const FEED_URL =
  "https://weworkremotely.com/categories/remote-programming-jobs.rss";

interface WwrItem {
  title: string;
  region: string;
  link: string;
  guid: string;
  pubDate: string;
  description: string;
}

/** Extract the text of the first `<tag>...</tag>`, unwrapping CDATA. */
function firstTag(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = block.match(re);
  if (!m) return null;
  let v = m[1].trim();
  const cdata = v.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  if (cdata) v = cdata[1].trim();
  return v;
}

/** Decode the handful of XML entities that appear in WWR titles/regions. */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Parse the RSS feed into items (regex-based; no XML dependency). */
function parseFeedItems(xml: string): WwrItem[] {
  const items: WwrItem[] = [];
  const itemBlocks = xml.match(/<item[\s>][\s\S]*?<\/item>/g) ?? [];
  for (const block of itemBlocks) {
    items.push({
      title: decodeEntities(firstTag(block, "title") ?? ""),
      region: decodeEntities(firstTag(block, "region") ?? ""),
      link: firstTag(block, "link") ?? "",
      guid: firstTag(block, "guid") ?? "",
      pubDate: firstTag(block, "pubDate") ?? "",
      description: firstTag(block, "description") ?? "",
    });
  }
  return items;
}

/** RFC-822 pubDate → ISO string, or undefined when unparseable. */
function pubDateToIso(pubDate: string): string | undefined {
  if (!pubDate) return undefined;
  const parsed = new Date(pubDate);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export const weworkremotelyAdapter: SourceAdapter = {
  source: "weworkremotely",

  async fetchJobs(ctx: CrawlCtx): Promise<RawJob[]> {
    let xml: string;
    try {
      const res = await ctx.fetch(FEED_URL);
      if (!res.ok) {
        ctx.recordError(`weworkremotely: feed returned HTTP ${res.status}`);
        return [];
      }
      xml = await res.text();
    } catch (err) {
      ctx.recordError(`weworkremotely: feed fetch failed: ${String(err)}`);
      return [];
    }

    const results: RawJob[] = [];

    for (const item of parseFeedItems(xml)) {
      const externalId = item.guid || item.link;
      if (!externalId || !item.link) continue;

      // Titles are "Company: Role" — split on the first ": ".
      const sepIndex = item.title.indexOf(": ");
      const company =
        sepIndex >= 0 ? item.title.slice(0, sepIndex).trim() : item.title;
      const title =
        sepIndex >= 0 ? item.title.slice(sepIndex + 2).trim() : item.title;

      results.push({
        source: "weworkremotely",
        externalId,
        url: item.link,
        title,
        company,
        location: item.region || undefined,
        description: item.description || undefined,
        postedAt: pubDateToIso(item.pubDate),
        raw: item,
      });
    }

    return results;
  },
};
