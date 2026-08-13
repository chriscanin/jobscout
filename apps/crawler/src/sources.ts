/**
 * Curated startup-intel sources (migration 0004).
 *
 * Seven hand-picked sources surface breakout startups before their roles hit
 * the big boards. Each source yields COMPANY names (not jobs); this module
 * extracts those names, resolves each to a public ATS board (greenhouse /
 * lever / ashby), and inserts new `companies` rows so the regular crawl
 * pipeline picks up their postings. Discord stays the notification channel —
 * nothing here posts.
 *
 * Source kinds:
 *   - rss  — Substack-style feeds; each <item> is one newsletter issue.
 *   - html — index/report pages (Ramp, Harmonic, a16z); the page text is
 *            LLM-extracted whole, keyed by a content hash so a changed page is
 *            reprocessed and an unchanged one is skipped.
 *   - yc   — the YC directory via the yc-oss JSON API; entries are companies
 *            already, one source_items row per company.
 *
 * Idempotency: `source_items` (unique on source_key + item_url) records every
 * processed issue / page-version / YC company; company inserts additionally
 * dedup on (ats, board_token) and careers_url like discovery does.
 *
 * All I/O (fetch, LLM, web search, DB) is injected so tests run offline.
 */

import { createHash } from "node:crypto";
import type {
  CuratedSourceKey,
  Db,
  DiscoveredVia,
  Logger,
} from "@jobscout/core";
import type { LlmClient } from "./llm.js";
import { extractCandidate, validateBoard, type SearchClient } from "./discovery.js";

// ---------------------------------------------------------------------------
// Source definitions
// ---------------------------------------------------------------------------

export type CuratedSourceKind = "rss" | "html" | "yc";

export interface CuratedSourceDef {
  key: CuratedSourceKey;
  label: string;
  kind: CuratedSourceKind;
  /** Feed URL (rss), page URL (html), or JSON API URL (yc). */
  url: string;
  /**
   * html only: candidate page URLs beyond `url`. EVERY reachable candidate is
   * processed (each keyed by its own url#content-hash), so pattern-only
   * sources (Harmonic's quarterly slugs) and multi-page batches (annual
   * startup lists) all land. Unreachable candidates are skipped silently —
   * e.g. a not-yet-published quarter. `now` is injected for tests.
   */
  candidateUrls?: (now: Date) => string[];
  /**
   * html only: deterministic company-name extractor over the RAW page HTML,
   * for pages that embed structured data (a16z data-company attributes, Index
   * JSON-LD, Founders Fund inline JSON) that tag-stripping would destroy.
   * When it returns non-empty, the LLM pass is skipped and the item's version
   * hash is taken over the extracted names (page markup noise never triggers
   * reprocessing). Empty result falls through to LLM extraction over text.
   */
  extractNames?: (html: string) => string[];
  /** Newest feed items to consider per run (rss only). Default 5. */
  maxItems?: number;
}

// ---------------------------------------------------------------------------
// Deterministic extractors for structured portfolio pages
// ---------------------------------------------------------------------------

/** Dedup + trim a raw extracted name list (shared by the extractors below). */
function cleanNames(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) {
    const name = htmlToText(r).trim();
    const key = normalizeName(name);
    if (!name || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * a16z portfolio: grid items carry data-company JSON attrs (single- or
 * double-quoted, inner quotes possibly &quot;-escaped).
 */
export function extractA16zNames(html: string): string[] {
  const names: string[] = [];
  const attrs = [
    ...html.matchAll(/data-company='([^']+)'/g),
    ...html.matchAll(/data-company="([^"]+)"/g),
  ];
  for (const m of attrs) {
    try {
      const parsed = JSON.parse(m[1].replace(/&quot;/g, '"')) as {
        display_name?: unknown;
        name?: unknown;
      };
      const name = parsed.display_name ?? parsed.name;
      if (typeof name === "string") names.push(name);
    } catch {
      // one malformed attr never kills the page
    }
  }
  return cleanNames(names);
}

/** Index Ventures: JSON-LD ItemList of {"@type":"ListItem",...,"name":"Figma"}. */
export function extractIndexNames(html: string): string[] {
  // The ItemList carries a couple of site-nav entries alongside companies.
  const NAV_JUNK = new Set(["indexventures", "companies"]);
  const names: string[] = [];
  for (const m of html.matchAll(
    /"@type"\s*:\s*"ListItem"[^}]*?"name"\s*:\s*"([^"]+)"/g,
  )) {
    if (!NAV_JUNK.has(normalizeName(m[1]))) names.push(m[1]);
  }
  return cleanNames(names);
}

/** Founders Fund: inline WordPress-REST JSON {"type":"company",...,"title":{"rendered":"Anduril"}}. */
export function extractFoundersFundNames(html: string): string[] {
  const names: string[] = [];
  for (const m of html.matchAll(
    /"type"\s*:\s*"company"[\s\S]*?"title"\s*:\s*\{\s*"rendered"\s*:\s*"([^"]+)"/g,
  )) {
    names.push(m[1]);
  }
  return cleanNames(names);
}

/**
 * Harmonic publishes each quarter under
 * `harmonic.ai/hot-25-startups/{qN}-{year}` (older quarters used
 * `hot-25-companies`); there is no index page or feed, so try the current
 * quarter and the two before it, newer first, both slug prefixes.
 */
export function harmonicCandidateUrls(now: Date): string[] {
  const urls: string[] = [];
  let q = Math.floor(now.getUTCMonth() / 3) + 1;
  let year = now.getUTCFullYear();
  for (let i = 0; i < 3; i++) {
    for (const prefix of ["hot-25-startups", "hot-25-companies"]) {
      urls.push(`https://harmonic.ai/${prefix}/q${q}-${year}`);
    }
    q -= 1;
    if (q === 0) {
      q = 4;
      year -= 1;
    }
  }
  return urls;
}

/**
 * The seven tracked sources. URLs verified working 2026-08-02 (five Substack
 * RSS feeds — Ramp's monthly vendor report is mirrored by the Ramp Economics
 * Lab Substack; YC via the daily-updated yc-oss static mirror of the official
 * directory, hiring companies only).
 */
export const CURATED_SOURCES: CuratedSourceDef[] = [
  {
    key: "yc-directory",
    label: "YC startup directory",
    kind: "yc",
    url: "https://yc-oss.github.io/api/companies/hiring.json",
  },
  {
    key: "ramp-vendor-report",
    label: "Ramp vendor reports",
    kind: "rss",
    url: "https://econlab.substack.com/feed",
    maxItems: 3,
  },
  {
    key: "harmonic-hot25",
    label: "Harmonic Hot 25",
    kind: "html",
    url: "https://harmonic.ai/hot-25-startups",
    candidateUrls: harmonicCandidateUrls,
  },
  {
    key: "a16z-build",
    label: "a16z Build newsletter",
    kind: "rss",
    url: "https://a16zbuild.substack.com/feed",
  },
  {
    key: "founders-you-should-know",
    label: "Founders You Should Know",
    kind: "rss",
    url: "https://newsletter.foundersysk.com/feed",
  },
  {
    key: "next-play",
    label: "Next Play newsletter",
    kind: "rss",
    url: "https://nextplayso.substack.com/feed",
  },
  {
    key: "early-days",
    label: "Early Days Substack",
    kind: "rss",
    url: "https://earlydaysbymerlin.substack.com/feed",
  },
  {
    key: "vc-a16z",
    label: "a16z portfolio",
    kind: "html",
    url: "https://a16z.com/portfolio/",
    extractNames: extractA16zNames,
  },
  {
    key: "vc-sequoia",
    label: "Sequoia portfolio",
    kind: "html",
    url: "https://sequoiacap.com/our-companies/",
  },
  {
    key: "vc-index",
    label: "Index Ventures portfolio",
    kind: "html",
    url: "https://www.indexventures.com/companies/",
    extractNames: extractIndexNames,
  },
  {
    key: "vc-founders-fund",
    label: "Founders Fund portfolio",
    kind: "html",
    url: "https://foundersfund.com/portfolio/",
    extractNames: extractFoundersFundNames,
  },
  {
    key: "tc-funding",
    label: "TechCrunch venture news",
    kind: "rss",
    url: "https://techcrunch.com/category/venture/feed/",
    maxItems: 10,
  },
  {
    key: "product-hunt",
    label: "Product Hunt launches",
    kind: "rss", // Atom feed — parseRssItems handles both
    url: "https://www.producthunt.com/feed",
    maxItems: 10,
  },
  {
    key: "pragmatic-engineer",
    label: "Pragmatic Engineer newsletter",
    kind: "rss",
    url: "https://newsletter.pragmaticengineer.com/feed",
  },
  {
    key: "startup-lists",
    label: "Annual startup lists",
    kind: "html",
    url: "https://www.forbes.com/lists/ai50/",
    // Each reachable list page is its own item (LinkedIn Top Startups URL is
    // edition-specific; swap in the new edition's slug when it ships).
    candidateUrls: () => [
      "https://www.forbes.com/lists/ai50/",
      "https://www.linkedin.com/pulse/linkedin-top-startups-2025-50-us-companies-rise-linkedin-news-hox6f",
      "https://www.enterprisetech30.com/",
    ],
  },
];

// ---------------------------------------------------------------------------
// Repo + stats types
// ---------------------------------------------------------------------------

/** The DB surface runSources needs. Tests inject a stub; prod wraps db.query. */
export interface SourcesRepo {
  findCompanyByAtsBoardToken(
    ats: string,
    board_token: string,
  ): Promise<{ id: string } | null>;
  findCompanyByCareersUrl(careers_url: string): Promise<{ id: string } | null>;
  insertCompany(row: {
    name: string;
    ats: string;
    board_token: string | null;
    careers_url: string | null;
    discovered_via: DiscoveredVia;
    active: boolean;
  }): Promise<void>;
  /** True when (source_key, item_url) was already processed. */
  hasItem(source_key: CuratedSourceKey, item_url: string): Promise<boolean>;
  /** Upsert a processed item (updates processed_at / companies_found on rerun). */
  recordItem(row: {
    source_key: CuratedSourceKey;
    item_url: string;
    title: string | null;
    companies_found: number;
  }): Promise<void>;
}

/** Per-source stats returned by runSources (mirrors DiscoveryStats' spirit). */
export interface SourceRunStats {
  source: CuratedSourceKey;
  /** Items seen in the feed/page/API this run. */
  items: number;
  /** Items actually processed (not previously recorded). */
  newItems: number;
  /** Company names the LLM (or YC API) yielded from new items. */
  extracted: number;
  /** New companies rows inserted. */
  inserted: number;
  /** Companies already known (any channel). */
  skippedKnown: number;
  /** Names that could not be resolved to a board (and had no website). */
  unresolved: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** One parsed RSS/Atom item. */
export interface FeedItem {
  title: string;
  link: string;
  content: string;
}

/**
 * Minimal RSS 2.0 / Atom parser for machine-generated feeds. RSS: <item>
 * blocks with <title>, <link>, and <content:encoded> (or <description>).
 * Atom (Product Hunt): <entry> blocks with <title>, <link href="..."/>, and
 * <content>. CDATA-wrapped or plain. Deliberately regex-based — a full XML
 * dependency isn't warranted for these feeds.
 */
export function parseRssItems(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  const itemBlocks = xml.match(/<item[\s>][\s\S]*?<\/item>/g) ?? [];
  for (const block of itemBlocks) {
    const title = firstTag(block, "title") ?? "";
    const link = firstTag(block, "link") ?? "";
    const content =
      firstTag(block, "content:encoded") ?? firstTag(block, "description") ?? "";
    if (link) items.push({ title, link, content });
  }
  if (items.length > 0) return items;

  // Atom fallback: <entry> with a self-closing <link href="..."/>.
  const entryBlocks = xml.match(/<entry[\s>][\s\S]*?<\/entry>/g) ?? [];
  for (const block of entryBlocks) {
    const title = firstTag(block, "title") ?? "";
    const href = block.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? "";
    const content =
      firstTag(block, "content") ?? firstTag(block, "summary") ?? "";
    if (href) items.push({ title, link: href, content });
  }
  return items;
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

/** Strip tags/scripts/styles and collapse whitespace: HTML → plain text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Stable short hash of page text — the "version key" for html sources. */
export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Lowercase alphanumeric squash for name comparison ("Acme AI" → "acmeai"). */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Board-token guesses for a company name: "Acme AI" → ["acmeai", "acme-ai"].
 * Deliberately near-exact only — a blind probe is weak evidence, and short
 * guesses like a bare first word collide with unrelated live boards (lever
 * echoes the slug back as the "name", so a collision would pass validation).
 * Shortened-name boards are found via the web-search fallback instead, where
 * the full quoted company name is part of the query.
 */
export function slugCandidates(name: string): string[] {
  const squashed = normalizeName(name);
  const hyphenated = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const out: string[] = [];
  for (const c of [squashed, hyphenated]) {
    if (c && c.length >= 3 && !out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * Do two company names plausibly refer to the same company? Normalized
 * equality or containment either way (so "Acme" matches "Acme AI, Inc.",
 * and a slug-derived name like "acmeai" matches "Acme AI").
 */
export function namesMatch(a: string, b: string): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na.length < 3 || nb.length < 3) return na === nb;
  return na === nb || na.includes(nb) || nb.includes(na);
}

// ---------------------------------------------------------------------------
// LLM company extraction
// ---------------------------------------------------------------------------

/** Longest text slice handed to the LLM per item/page. */
const MAX_EXTRACT_CHARS = 16_000;

/** Most company names accepted from one item/page. */
const MAX_COMPANIES_PER_ITEM = 30;

const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    companies: { type: "array", items: { type: "string" } },
  },
  required: ["companies"],
  additionalProperties: false,
} as const;

/**
 * Ask the LLM for the startup names featured in a chunk of source text.
 * Returns a deduped list (original casing, ≤ MAX_COMPANIES_PER_ITEM).
 */
export async function extractCompanies(
  llm: LlmClient,
  sourceLabel: string,
  text: string,
): Promise<string[]> {
  const raw = await llm.complete({
    system:
      "You extract startup company names from startup-industry content. " +
      "Return ONLY companies presented as noteworthy/breakout/hiring startups " +
      "(featured companies, list entries, profiled companies). Exclude: the " +
      "publication itself, VC firms, big incumbents (Google, Microsoft, etc.), " +
      "people, and products without a company. Company names verbatim.",
    user:
      `Source: ${sourceLabel}\n\n` +
      `Content:\n${text.slice(0, MAX_EXTRACT_CHARS)}\n\n` +
      `Return JSON: {"companies": ["Name", ...]} — empty array if none.`,
    tier: "default",
    maxTokens: 1024,
    jsonSchema: EXTRACT_SCHEMA,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = (parsed as { companies?: unknown }).companies;
  if (!Array.isArray(list)) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of list) {
    if (typeof v !== "string") continue;
    const name = v.trim();
    const key = normalizeName(name);
    if (name.length === 0 || key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= MAX_COMPANIES_PER_ITEM) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Company → ATS board resolution
// ---------------------------------------------------------------------------

/** The ATSes a company can be resolved onto (all have crawl adapters). */
export type ResolvableAts =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "smartrecruiters"
  | "workable"
  | "recruitee";

const RESOLVABLE_ATSES: readonly ResolvableAts[] = [
  "greenhouse",
  "lever",
  "ashby",
  "smartrecruiters",
  "workable",
  "recruitee",
];

export interface ResolvedBoard {
  ats: ResolvableAts;
  board_token: string;
  /** Name from the board API (falls back to the input name). */
  name: string;
}

/**
 * Validate a candidate board on any resolvable ATS. Greenhouse/lever/ashby
 * delegate to discovery's validateBoard; the other three probe their public
 * account endpoints (verified shapes, 2026-08-02):
 *   - smartrecruiters: postings list; valid only when totalFound >= 1
 *     (unknown identifiers return 200 with totalFound 0).
 *   - workable: widget account endpoint; 404 = unknown slug.
 *   - recruitee: offers endpoint; 404 = unknown slug.
 */
export async function validateAnyBoard(
  fetchFn: typeof fetch,
  ats: ResolvableAts,
  slug: string,
): Promise<{ valid: true; name: string } | { valid: false }> {
  if (ats === "greenhouse" || ats === "lever" || ats === "ashby") {
    return validateBoard(fetchFn, ats, slug);
  }

  const url =
    ats === "smartrecruiters"
      ? `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=1`
      : ats === "workable"
        ? `https://apply.workable.com/api/v1/widget/accounts/${slug}`
        : `https://${slug}.recruitee.com/api/offers/`;

  let res: Response;
  try {
    res = await fetchFn(url);
  } catch {
    return { valid: false };
  }
  if (res.status !== 200) return { valid: false };

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { valid: false };
  }
  if (typeof body !== "object" || body === null) return { valid: false };
  const rec = body as Record<string, unknown>;

  if (ats === "smartrecruiters") {
    const total = rec["totalFound"];
    if (typeof total !== "number" || total < 1) return { valid: false };
    const first = Array.isArray(rec["content"]) ? rec["content"][0] : undefined;
    const company = (first as { company?: { name?: unknown } } | undefined)?.company;
    return {
      valid: true,
      name: typeof company?.name === "string" ? company.name : slug,
    };
  }

  if (ats === "workable") {
    return {
      valid: true,
      name: typeof rec["name"] === "string" && rec["name"] ? (rec["name"] as string) : slug,
    };
  }

  // recruitee
  const offers = rec["offers"];
  if (!Array.isArray(offers)) return { valid: false };
  const companyName = (offers[0] as { company_name?: unknown } | undefined)?.company_name;
  return {
    valid: true,
    name: typeof companyName === "string" && companyName ? companyName : slug,
  };
}

/**
 * Parse a search-result URL into a board candidate across all six resolvable
 * ATSes. Greenhouse/lever/ashby via discovery's extractCandidate; plus:
 *   careers.smartrecruiters.com/{Company}   jobs.smartrecruiters.com/{Company}
 *   apply.workable.com/{slug}               {slug}.recruitee.com
 */
export function extractAnyCandidate(
  url: string,
): { ats: ResolvableAts; board_token: string } | null {
  const base = extractCandidate(url);
  if (base.kind === "board") {
    return { ats: base.ats, board_token: base.board_token };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split("/").filter((s) => s.length > 0);

  if (
    (host === "careers.smartrecruiters.com" || host === "jobs.smartrecruiters.com") &&
    segments[0]
  ) {
    return { ats: "smartrecruiters", board_token: segments[0].toLowerCase() };
  }

  if (host === "apply.workable.com" && segments[0] && segments[0] !== "api") {
    return { ats: "workable", board_token: segments[0].toLowerCase() };
  }

  const recruiteeMatch = host.match(/^([a-z0-9-]+)\.recruitee\.com$/);
  if (recruiteeMatch && recruiteeMatch[1] !== "www" && recruiteeMatch[1] !== "api") {
    return { ats: "recruitee", board_token: recruiteeMatch[1] };
  }

  return null;
}

/**
 * Resolve a company name to a live ATS board:
 *  1. Probe slug guesses against each board API; accept only when the board's
 *     own company name plausibly matches (guards against slug collisions).
 *  2. Fall back to one web search across the three board hosts, validating
 *     candidates the same way.
 * Returns null when nothing validates.
 */
export async function resolveCompanyBoard(
  name: string,
  deps: {
    fetchFn: typeof fetch;
    searchClient?: SearchClient;
    logger: Logger;
  },
): Promise<ResolvedBoard | null> {
  const { fetchFn, searchClient, logger } = deps;

  // 1. Direct slug probes across all six resolvable ATSes
  for (const slug of slugCandidates(name)) {
    for (const ats of RESOLVABLE_ATSES) {
      const result = await validateAnyBoard(fetchFn, ats, slug);
      if (result.valid && namesMatch(name, result.name)) {
        return { ats, board_token: slug, name: pickName(name, result.name, slug) };
      }
    }
  }

  // 2. Web-search fallback. A search ERROR (auth, network) throws — the caller
  // records the failure and leaves the item unprocessed so it retries next run;
  // returning null here would persist a wrong "no board" verdict.
  if (!searchClient) return null;
  let results: { url: string; title: string }[];
  try {
    results = await searchClient.search(
      `"${name}" jobs (site:job-boards.greenhouse.io OR site:jobs.lever.co` +
        ` OR site:jobs.ashbyhq.com OR site:careers.smartrecruiters.com` +
        ` OR site:apply.workable.com OR site:recruitee.com)`,
    );
  } catch (err) {
    logger.warn(`sources: search failed for "${name}": ${String(err)}`);
    throw new Error(`web search failed for "${name}": ${String(err)}`);
  }

  const tried = new Set<string>();
  for (const { url } of results) {
    const candidate = extractAnyCandidate(url);
    if (candidate === null) continue;
    const key = `${candidate.ats}:${candidate.board_token}`;
    if (tried.has(key)) continue;
    tried.add(key);
    if (tried.size > 5) break;
    const result = await validateAnyBoard(fetchFn, candidate.ats, candidate.board_token);
    if (result.valid && namesMatch(name, result.name)) {
      return {
        ats: candidate.ats,
        board_token: candidate.board_token,
        name: pickName(name, result.name, candidate.board_token),
      };
    }
  }
  return null;
}

/** Prefer the board API's name unless it is just the slug echoed back. */
function pickName(input: string, boardName: string, slug: string): string {
  return normalizeName(boardName) === normalizeName(slug) ? input : boardName;
}

// ---------------------------------------------------------------------------
// YC directory entries
// ---------------------------------------------------------------------------

/** The yc-oss company fields we read (superset-tolerant). */
export interface YcCompany {
  name: string;
  website: string | null;
  batch: string | null;
  isHiring: boolean;
  url: string;
}

/** Parse a yc-oss companies payload into typed entries (unknown-safe). */
export function parseYcCompanies(json: unknown): YcCompany[] {
  if (!Array.isArray(json)) return [];
  const out: YcCompany[] = [];
  for (const raw of json) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (!name) continue;
    out.push({
      name,
      website: typeof r.website === "string" && r.website ? r.website : null,
      batch: typeof r.batch === "string" ? r.batch : null,
      isHiring: r.isHiring === true,
      url:
        typeof r.url === "string" && r.url
          ? r.url
          : `yc:${normalizeName(name)}`,
    });
  }
  return out;
}

/** Most YC companies processed per run (newest batches first, hiring only). */
const YC_MAX_PER_RUN = 40;

// ---------------------------------------------------------------------------
// runSources
// ---------------------------------------------------------------------------

export interface RunSourcesDeps {
  /** Override the tracked source list (tests; --source filter). */
  sources?: CuratedSourceDef[];
  fetchFn: typeof fetch;
  llm: LlmClient;
  /** Optional — without it, resolution uses slug probes only. */
  searchClient?: SearchClient;
  repo: SourcesRepo;
  logger: Logger;
  /** Clock (injectable for candidateUrls tests). Default: () => new Date(). */
  now?: () => Date;
}

/** Default newest-items window for rss sources. */
const RSS_MAX_ITEMS = 5;

/**
 * Run every curated source, isolated (one failing source never kills the run).
 * Returns per-source stats in source order.
 */
export async function runSources(deps: RunSourcesDeps): Promise<SourceRunStats[]> {
  const sources = deps.sources ?? CURATED_SOURCES;
  const all: SourceRunStats[] = [];
  for (const source of sources) {
    const stats: SourceRunStats = {
      source: source.key,
      items: 0,
      newItems: 0,
      extracted: 0,
      inserted: 0,
      skippedKnown: 0,
      unresolved: 0,
      errors: [],
    };
    try {
      if (source.kind === "rss") await runRssSource(source, deps, stats);
      else if (source.kind === "html") await runHtmlSource(source, deps, stats);
      else await runYcSource(source, deps, stats);
    } catch (err) {
      const msg = `sources[${source.key}]: ${String(err)}`;
      deps.logger.error(msg);
      stats.errors.push(msg);
    }
    deps.logger.info(
      `sources[${source.key}]: ${stats.newItems}/${stats.items} new item(s), ` +
        `${stats.extracted} extracted, ${stats.inserted} inserted, ` +
        `${stats.skippedKnown} known, ${stats.unresolved} unresolved` +
        (stats.errors.length ? `, ${stats.errors.length} error(s)` : ""),
    );
    all.push(stats);
  }
  return all;
}

/** Resolve + insert one extracted company name. Shared by rss/html paths. */
async function ingestCompanyName(
  name: string,
  source: CuratedSourceDef,
  deps: RunSourcesDeps,
  stats: SourceRunStats,
): Promise<void> {
  const { repo, logger } = deps;
  const resolved = await resolveCompanyBoard(name, {
    fetchFn: deps.fetchFn,
    searchClient: deps.searchClient,
    logger,
  });
  if (!resolved) {
    stats.unresolved++;
    logger.debug(`sources[${source.key}]: unresolved "${name}"`);
    return;
  }
  const existing = await repo.findCompanyByAtsBoardToken(
    resolved.ats,
    resolved.board_token,
  );
  if (existing) {
    stats.skippedKnown++;
    return;
  }
  await repo.insertCompany({
    name: resolved.name,
    ats: resolved.ats,
    board_token: resolved.board_token,
    careers_url: null,
    discovered_via: source.key,
    active: true,
  });
  stats.inserted++;
  logger.info(
    `sources[${source.key}]: + ${resolved.name} (${resolved.ats}/${resolved.board_token})`,
  );
}

/** rss: newest N feed items, each an issue processed once, ever. */
async function runRssSource(
  source: CuratedSourceDef,
  deps: RunSourcesDeps,
  stats: SourceRunStats,
): Promise<void> {
  const res = await deps.fetchFn(source.url);
  if (!res.ok) throw new Error(`feed fetch HTTP ${res.status} (${source.url})`);
  const xml = await res.text();
  const items = parseRssItems(xml).slice(0, source.maxItems ?? RSS_MAX_ITEMS);
  stats.items = items.length;

  for (const item of items) {
    if (await deps.repo.hasItem(source.key, item.link)) continue;
    stats.newItems++;
    const text = htmlToText(`${item.title}. ${item.content}`);
    const names = await extractCompanies(deps.llm, source.label, text);
    stats.extracted += names.length;
    const errorsBefore = stats.errors.length;
    for (const name of names) {
      try {
        await ingestCompanyName(name, source, deps, stats);
      } catch (err) {
        stats.errors.push(`"${name}": ${String(err)}`);
      }
    }
    // Record only fully-clean items: an item with errors stays unprocessed so
    // the next run retries it (company-level dedup makes reprocessing safe).
    if (stats.errors.length === errorsBefore) {
      await deps.repo.recordItem({
        source_key: source.key,
        item_url: item.link,
        title: item.title || null,
        companies_found: names.length,
      });
    }
  }
}

/**
 * html: each reachable candidate page is one item, keyed by URL + content
 * hash — reprocessed only when its content changes. Unreachable candidates
 * (not-yet-published quarters, moved slugs) are skipped; the source only
 * fails when NO candidate is reachable.
 */
async function runHtmlSource(
  source: CuratedSourceDef,
  deps: RunSourcesDeps,
  stats: SourceRunStats,
): Promise<void> {
  const candidates = source.candidateUrls
    ? source.candidateUrls((deps.now ?? (() => new Date()))())
    : [source.url];

  let reachable = 0;
  for (const pageUrl of candidates) {
    let res: Response;
    try {
      res = await deps.fetchFn(pageUrl);
    } catch {
      continue;
    }
    if (!res.ok) continue;
    reachable++;
    stats.items++;

    const html = await res.text();
    const structured = source.extractNames ? source.extractNames(html) : [];
    // Version over extracted names when structured (markup noise never
    // triggers reprocessing); over stripped text otherwise.
    const text = htmlToText(html);
    const versionKey = `${pageUrl}#${contentHash(
      structured.length > 0 ? structured.join("|") : text,
    )}`;
    if (await deps.repo.hasItem(source.key, versionKey)) continue;
    stats.newItems++;

    const names =
      structured.length > 0
        ? structured.slice(0, MAX_COMPANIES_PER_ITEM * 4)
        : await extractCompanies(deps.llm, source.label, text);
    stats.extracted += names.length;
    const errorsBefore = stats.errors.length;
    for (const name of names) {
      try {
        await ingestCompanyName(name, source, deps, stats);
      } catch (err) {
        stats.errors.push(`"${name}": ${String(err)}`);
      }
    }
    // Same retry rule as rss: only a fully-clean page version is recorded.
    if (stats.errors.length === errorsBefore) {
      await deps.repo.recordItem({
        source_key: source.key,
        item_url: versionKey,
        title: source.label,
        companies_found: names.length,
      });
    }
  }

  if (reachable === 0) {
    throw new Error(`no candidate page reachable (tried ${candidates.length})`);
  }
}

/**
 * yc: hiring companies from the directory API, newest batches first, one
 * source_items row per company (so each is attempted once, ever). Companies
 * whose board can't be resolved are still inserted (ats=unknown + website) so
 * the board shows them as tracked-but-uncrawlable.
 */
async function runYcSource(
  source: CuratedSourceDef,
  deps: RunSourcesDeps,
  stats: SourceRunStats,
): Promise<void> {
  const url = source.url;
  const res = await deps.fetchFn(url);
  if (!res.ok) throw new Error(`yc api HTTP ${res.status} (${url})`);
  const companies = parseYcCompanies(await res.json());

  // Hiring companies only, newest batches first. Batch strings sort naturally
  // enough by parsing "Winter 2026"/"W26"-style labels is overkill — the feed
  // is already roughly chronological, so take from the END (newest last).
  const hiring = companies.filter((c) => c.isHiring);
  stats.items = hiring.length;
  const slice = hiring.slice(-YC_MAX_PER_RUN).reverse();

  for (const company of slice) {
    if (await deps.repo.hasItem(source.key, company.url)) continue;
    stats.newItems++;
    stats.extracted++;
    try {
      const resolved = await resolveCompanyBoard(company.name, {
        fetchFn: deps.fetchFn,
        searchClient: deps.searchClient,
        logger: deps.logger,
      });
      if (resolved) {
        const existing = await deps.repo.findCompanyByAtsBoardToken(
          resolved.ats,
          resolved.board_token,
        );
        if (existing) {
          stats.skippedKnown++;
        } else {
          await deps.repo.insertCompany({
            name: resolved.name,
            ats: resolved.ats,
            board_token: resolved.board_token,
            careers_url: null,
            discovered_via: source.key,
            active: true,
          });
          stats.inserted++;
        }
      } else if (company.website) {
        const existing = await deps.repo.findCompanyByCareersUrl(company.website);
        if (existing) {
          stats.skippedKnown++;
        } else {
          await deps.repo.insertCompany({
            name: company.name,
            ats: "unknown",
            board_token: null,
            careers_url: company.website,
            discovered_via: source.key,
            active: true,
          });
          stats.inserted++;
        }
      } else {
        stats.unresolved++;
      }
      await deps.repo.recordItem({
        source_key: source.key,
        item_url: company.url,
        title: company.name + (company.batch ? ` (${company.batch})` : ""),
        companies_found: 1,
      });
    } catch (err) {
      stats.errors.push(`"${company.name}": ${String(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Production DB-backed SourcesRepo
// ---------------------------------------------------------------------------

/** Build a SourcesRepo over a Db (production). Tests inject a stub instead. */
export function createDbSourcesRepo(db: Db): SourcesRepo {
  return {
    async findCompanyByAtsBoardToken(ats, board_token) {
      const res = await db.query(
        `select id from companies where ats = $1 and board_token = $2 limit 1`,
        [ats, board_token],
      );
      return (res.rows[0] as { id: string } | undefined) ?? null;
    },

    async findCompanyByCareersUrl(careers_url) {
      const res = await db.query(
        `select id from companies where careers_url = $1 limit 1`,
        [careers_url],
      );
      return (res.rows[0] as { id: string } | undefined) ?? null;
    },

    async insertCompany(row) {
      await db.query(
        `insert into companies (name, ats, board_token, careers_url, discovered_via, active)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (ats, board_token) do nothing`,
        [
          row.name,
          row.ats,
          row.board_token,
          row.careers_url,
          row.discovered_via,
          row.active,
        ],
      );
    },

    async hasItem(source_key, item_url) {
      const res = await db.query(
        `select 1 from source_items where source_key = $1 and item_url = $2 limit 1`,
        [source_key, item_url],
      );
      return res.rows.length > 0;
    },

    async recordItem(row) {
      await db.query(
        `insert into source_items (source_key, item_url, title, companies_found)
         values ($1, $2, $3, $4)
         on conflict (source_key, item_url)
         do update set processed_at = now(), companies_found = excluded.companies_found`,
        [row.source_key, row.item_url, row.title, row.companies_found],
      );
    },
  };
}
