/**
 * Web-search-based company discovery (spec 04).
 *
 * Runs a fixed set of searches via an injected SearchClient (backed by the
 * Anthropic web_search tool in production), extracts ATS board candidates from
 * result URLs, validates each candidate against its public board API, and inserts
 * new companies rows with discovered_via = 'web-search'.
 *
 * All I/O is injected so tests can mock everything with zero network calls.
 */

import type { Criteria } from "@jobscout/core";
import type { Logger } from "@jobscout/core";
import type { Db } from "@jobscout/core";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A parsed candidate from a search-result URL.
 *  - kind='board': a recognised ATS board URL; board_token is the slug.
 *  - kind='page': a generic URL that needs HTML fetching to determine ATS.
 */
export type BoardCandidate =
  | { kind: "board"; ats: "greenhouse" | "lever" | "ashby"; board_token: string }
  | { kind: "page"; url: string };

/** Stats returned by runDiscovery. */
export interface DiscoveryStats {
  searches: number;
  inserted: number;
  skippedKnown: number;
  invalid: number;
  other: number;
  errors: string[];
}

/**
 * Thin injectable wrapper around the Anthropic web_search tool.
 * In production this is backed by createAnthropicSearchClient().
 * In tests a mock is injected directly.
 */
export interface SearchClient {
  search(query: string): Promise<{ url: string; title: string }[]>;
}

/**
 * A minimal companies repo — the subset of DB operations discovery needs.
 * Tests inject a stub; production passes a thin wrapper around db.query.
 */
export interface CompaniesRepo {
  /** Return existing rows matching (ats, board_token) pairs (for dedup). */
  findByAtsBoardToken(
    ats: string,
    board_token: string,
  ): Promise<{ id: string } | null>;
  /** Return existing row matching careers_url (for ats=other dedup). */
  findByCareersUrl(careers_url: string): Promise<{ id: string } | null>;
  /** Insert a new companies row. */
  insert(row: {
    name: string;
    ats: string;
    board_token: string | null;
    careers_url: string | null;
    discovered_via: "web-search";
    active: true;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Pure functions (extractCandidate, buildDiscoveryQueries)
// ---------------------------------------------------------------------------

/**
 * Parse a URL from a search result and return either a board candidate (when
 * the host is a recognised ATS job-board) or a generic page candidate.
 *
 * Recognised patterns:
 *   job-boards.greenhouse.io/{token}/...  → greenhouse
 *   boards.greenhouse.io/{token}          → greenhouse
 *   jobs.lever.co/{site}/...             → lever
 *   jobs.ashbyhq.com/{org}/...           → ashby
 *
 * Token is always lowercased; trailing path segments after the first are
 * dropped (job IDs etc.).
 */
export function extractCandidate(url: string): BoardCandidate {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: "page", url };
  }

  const host = parsed.hostname.toLowerCase();
  // Path segments excluding empty strings from leading slash
  const segments = parsed.pathname.split("/").filter((s) => s.length > 0);

  if (host === "job-boards.greenhouse.io" || host === "boards.greenhouse.io") {
    const token = segments[0];
    if (token) {
      return { kind: "board", ats: "greenhouse", board_token: token.toLowerCase() };
    }
  }

  if (host === "jobs.lever.co") {
    const token = segments[0];
    if (token) {
      return { kind: "board", ats: "lever", board_token: token.toLowerCase() };
    }
  }

  if (host === "jobs.ashbyhq.com") {
    const token = segments[0];
    if (token) {
      return { kind: "board", ats: "ashby", board_token: token.toLowerCase() };
    }
  }

  return { kind: "page", url };
}

/**
 * Build the fixed query set from the criteria (at most 8 queries).
 *
 * Structure (per spec §2):
 *   - For each priority group (sorted by priority asc), for each keyword,
 *     generate targeted queries against each ATS board host.
 *   - Then append generic queries.
 *   - Truncate at 8.
 *
 * The query strings use `site:` as a readability convention; the actual domain
 * scoping is done by the SearchClient via allowed_domains (not trusted in text).
 */
export function buildDiscoveryQueries(criteria: Criteria): string[] {
  const MAX = 8;
  const queries: string[] = [];

  // Collect all keywords across priority groups, ordered by priority (asc = highest first).
  const sorted = [...criteria.role_priorities].sort((a, b) => a.priority - b.priority);

  // ATS board hosts to target
  const boardHosts = [
    "job-boards.greenhouse.io",
    "boards.greenhouse.io",
    "jobs.lever.co",
    "jobs.ashbyhq.com",
  ] as const;

  for (const group of sorted) {
    for (const kw of group.keywords) {
      for (const host of boardHosts) {
        queries.push(`site:${host} ${kw}`);
        if (queries.length >= MAX) return queries;
      }
    }
  }

  // Generic fallback queries (if budget not exhausted)
  const genericKeywords = sorted[0]?.keywords ?? [];
  for (const kw of genericKeywords) {
    queries.push(`${kw} jobs remote careers`);
    if (queries.length >= MAX) return queries;
  }

  return queries;
}

// ---------------------------------------------------------------------------
// Board API validation
// ---------------------------------------------------------------------------

/** Validation API URLs for each ATS. */
function validationUrl(ats: "greenhouse" | "lever" | "ashby", board_token: string): string {
  switch (ats) {
    case "greenhouse":
      return `https://boards-api.greenhouse.io/v1/boards/${board_token}/jobs`;
    case "lever":
      return `https://api.lever.co/v0/postings/${board_token}?mode=json`;
    case "ashby":
      return `https://api.ashbyhq.com/posting-api/job-board/${board_token}`;
  }
}

/**
 * Fetch the board API to confirm the board exists (status 200) and extract the
 * company name from the payload when available.
 *
 * Returns `{ valid: true, name }` or `{ valid: false }`.
 */
async function validateBoard(
  fetchFn: typeof fetch,
  ats: "greenhouse" | "lever" | "ashby",
  board_token: string,
): Promise<{ valid: true; name: string } | { valid: false }> {
  const url = validationUrl(ats, board_token);
  let res: Response;
  try {
    res = await fetchFn(url);
  } catch (err) {
    return { valid: false };
  }

  if (res.status !== 200) return { valid: false };

  try {
    const body = await res.json() as unknown;
    const name = extractNameFromBoardPayload(ats, board_token, body);
    return { valid: true, name };
  } catch {
    // Non-JSON or parse error — board exists (200) but name unknown; use slug
    return { valid: true, name: board_token };
  }
}

/** Extract a human-readable company name from a board API response. */
function extractNameFromBoardPayload(
  ats: "greenhouse" | "lever" | "ashby",
  board_token: string,
  body: unknown,
): string {
  if (typeof body !== "object" || body === null) return board_token;

  if (ats === "greenhouse") {
    // { meta: { name: "Company" }, jobs: [...] }
    const meta = (body as Record<string, unknown>)["meta"];
    if (typeof meta === "object" && meta !== null) {
      const name = (meta as Record<string, unknown>)["name"];
      if (typeof name === "string" && name.trim().length > 0) return name.trim();
    }
  }

  if (ats === "lever") {
    // Array of postings; extract from hostedUrl or fall back to slug
    if (Array.isArray(body) && body.length > 0) {
      // Lever doesn't return company name in posting-list; use slug
      return board_token;
    }
  }

  if (ats === "ashby") {
    // { success: true, data: { organization: { name: "..." } } }
    const data = (body as Record<string, unknown>)["data"];
    if (typeof data === "object" && data !== null) {
      const org = (data as Record<string, unknown>)["organization"];
      if (typeof org === "object" && org !== null) {
        const name = (org as Record<string, unknown>)["name"];
        if (typeof name === "string" && name.trim().length > 0) return name.trim();
      }
    }
  }

  return board_token;
}

// ---------------------------------------------------------------------------
// robots.txt checking
// ---------------------------------------------------------------------------

/**
 * Parse a robots.txt body and return true if `User-agent: *` (or the given UA)
 * allows fetching `path`. Conservative: any Disallow matching the path prefix
 * blocks it.
 */
function isAllowedByRobots(robotsTxt: string, path: string, _ua = "*"): boolean {
  const lines = robotsTxt.split(/\r?\n/);
  let inRelevantBlock = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const field = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (field === "user-agent") {
      inRelevantBlock = value === "*" || value.toLowerCase() === _ua.toLowerCase();
      continue;
    }

    if (inRelevantBlock && field === "disallow") {
      if (value.length > 0 && path.startsWith(value)) {
        return false; // blocked
      }
    }
  }

  return true; // allowed
}

// ---------------------------------------------------------------------------
// HTML ATS link extraction
// ---------------------------------------------------------------------------

const ATS_LINK_PATTERNS: Array<{
  ats: "greenhouse" | "lever" | "ashby";
  pattern: RegExp;
}> = [
  {
    ats: "lever",
    // https://jobs.lever.co/{site}/optional-id
    pattern: /https?:\/\/jobs\.lever\.co\/([A-Za-z0-9_-]+)/,
  },
  {
    ats: "greenhouse",
    // https://job-boards.greenhouse.io/{token}
    pattern: /https?:\/\/job-boards\.greenhouse\.io\/([A-Za-z0-9_-]+)/,
  },
  {
    ats: "greenhouse",
    // https://boards.greenhouse.io/{token}
    pattern: /https?:\/\/boards\.greenhouse\.io\/([A-Za-z0-9_-]+)/,
  },
  {
    ats: "ashby",
    // https://jobs.ashbyhq.com/{org}
    pattern: /https?:\/\/jobs\.ashbyhq\.com\/([A-Za-z0-9_-]+)/,
  },
];

/**
 * Scan raw HTML text for recognisable ATS links.
 * Returns the first match as a board candidate, or null if none found.
 */
function extractAtsLinkFromHtml(
  html: string,
): { ats: "greenhouse" | "lever" | "ashby"; board_token: string } | null {
  for (const { ats, pattern } of ATS_LINK_PATTERNS) {
    const m = html.match(pattern);
    if (m && m[1]) {
      return { ats, board_token: m[1].toLowerCase() };
    }
  }
  return null;
}

/** Extract text from an HTML <title> tag (simple regex; no full parse needed). */
function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (m && m[1]) return m[1].trim();
  return null;
}

/** Extract registrable domain from a URL (e.g. "https://careers.acme.com/jobs" → "acme.com"). */
function registrableDomain(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.hostname.split(".");
    if (parts.length >= 2) {
      return parts.slice(-2).join(".");
    }
    return parsed.hostname;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// runDiscovery
// ---------------------------------------------------------------------------

/**
 * Run board discovery:
 * 1. Build queries from criteria (at most 8).
 * 2. For each query, call searchClient.search().
 * 3. For each result URL, extract a BoardCandidate.
 * 4. Deduplicate candidates within the run and against the existing companies table.
 * 5. For 'board' candidates: validate via the public board API; insert if valid.
 * 6. For 'page' candidates: check robots.txt; if allowed, fetch HTML and scan
 *    for ATS links → upgrade to board candidate or insert as ats=other.
 */
export async function runDiscovery(deps: {
  searchClient: SearchClient;
  fetchFn: typeof fetch;
  companies: CompaniesRepo;
  criteria: Criteria;
  logger: Logger;
}): Promise<DiscoveryStats> {
  const { searchClient, fetchFn, companies, criteria, logger } = deps;

  const stats: DiscoveryStats = {
    searches: 0,
    inserted: 0,
    skippedKnown: 0,
    invalid: 0,
    other: 0,
    errors: [],
  };

  const queries = buildDiscoveryQueries(criteria);

  // Collect all unique candidates across all search results
  // Key for board: `${ats}:${board_token}`, for page: `page:${url}`
  const seenKeys = new Set<string>();
  const boardCandidates: Array<{ ats: "greenhouse" | "lever" | "ashby"; board_token: string }> = [];
  const pageCandidates: Array<{ url: string }> = [];

  for (const query of queries) {
    stats.searches++;
    let results: { url: string; title: string }[];
    try {
      results = await searchClient.search(query);
    } catch (err) {
      const msg = `Search failed for query "${query}": ${String(err)}`;
      logger.warn(msg);
      stats.errors.push(msg);
      continue;
    }

    for (const { url } of results) {
      const candidate = extractCandidate(url);
      if (candidate.kind === "board") {
        const key = `${candidate.ats}:${candidate.board_token}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          boardCandidates.push({ ats: candidate.ats, board_token: candidate.board_token });
        }
      } else {
        const key = `page:${candidate.url}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          pageCandidates.push({ url: candidate.url });
        }
      }
    }
  }

  // Process board candidates
  for (const { ats, board_token } of boardCandidates) {
    try {
      // Skip if already in DB
      const existing = await companies.findByAtsBoardToken(ats, board_token);
      if (existing) {
        logger.debug(`Skipping known board ${ats}/${board_token}`);
        stats.skippedKnown++;
        continue;
      }

      // Validate against board API
      const result = await validateBoard(fetchFn, ats, board_token);
      if (!result.valid) {
        logger.info(`Board API returned non-200 for ${ats}/${board_token}; skipping`);
        stats.invalid++;
        continue;
      }

      // Insert
      await companies.insert({
        name: result.name,
        ats,
        board_token,
        careers_url: null,
        discovered_via: "web-search",
        active: true,
      });
      logger.info(`Inserted ${ats}/${board_token} (${result.name})`);
      stats.inserted++;
    } catch (err) {
      const msg = `Error processing board ${ats}/${board_token}: ${String(err)}`;
      logger.error(msg);
      stats.errors.push(msg);
    }
  }

  // Process page candidates
  for (const { url } of pageCandidates) {
    try {
      // Fetch robots.txt first
      let robotsUrl: string;
      try {
        const parsed = new URL(url);
        robotsUrl = `${parsed.protocol}//${parsed.host}/robots.txt`;
      } catch {
        const msg = `Could not parse URL for robots.txt check: ${url}`;
        logger.warn(msg);
        stats.errors.push(msg);
        continue;
      }

      let robotsTxt = "";
      try {
        const robotsRes = await fetchFn(robotsUrl);
        if (robotsRes.ok) {
          robotsTxt = await robotsRes.text();
        }
      } catch {
        // robots.txt fetch failed → treat as allowed (conservative)
        robotsTxt = "";
      }

      const parsedUrl = new URL(url);
      if (!isAllowedByRobots(robotsTxt, parsedUrl.pathname)) {
        const msg = `robots.txt disallows ${url}; skipping`;
        logger.info(msg);
        stats.errors.push(msg);
        continue;
      }

      // Fetch the page
      const pageRes = await fetchFn(url);
      if (!pageRes.ok) {
        const msg = `Page fetch returned ${pageRes.status} for ${url}; skipping`;
        logger.info(msg);
        stats.invalid++;
        continue;
      }

      const html = await pageRes.text();

      // Scan for ATS links
      const atsLink = extractAtsLinkFromHtml(html);
      if (atsLink) {
        const { ats, board_token } = atsLink;
        // Check if already known
        const existing = await companies.findByAtsBoardToken(ats, board_token);
        if (existing) {
          logger.debug(`Skipping known board ${ats}/${board_token} (found via page ${url})`);
          stats.skippedKnown++;
          continue;
        }

        // Validate the discovered board
        const result = await validateBoard(fetchFn, ats, board_token);
        if (!result.valid) {
          logger.info(`Board API returned non-200 for ${ats}/${board_token} (from page ${url}); skipping`);
          stats.invalid++;
          continue;
        }

        await companies.insert({
          name: result.name,
          ats,
          board_token,
          careers_url: null,
          discovered_via: "web-search",
          active: true,
        });
        logger.info(`Inserted ${ats}/${board_token} (${result.name}) via page ${url}`);
        stats.inserted++;
        continue;
      }

      // No recognisable ATS — insert as ats=other if not already known
      const existingOther = await companies.findByCareersUrl(url);
      if (existingOther) {
        logger.debug(`Skipping known careers_url ${url}`);
        stats.skippedKnown++;
        continue;
      }

      // Derive name from <title> or domain
      const rawTitle = extractTitle(html);
      const name = rawTitle
        ? rawTitle.slice(0, 80)
        : registrableDomain(url);

      await companies.insert({
        name,
        ats: "other",
        board_token: null,
        careers_url: url,
        discovered_via: "web-search",
        active: true,
      });
      logger.info(`Inserted ats=other for ${url} (${name})`);
      stats.inserted++;
      stats.other++;
    } catch (err) {
      const msg = `Error processing page ${url}: ${String(err)}`;
      logger.error(msg);
      stats.errors.push(msg);
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Production-wired DB-backed CompaniesRepo
// ---------------------------------------------------------------------------

/**
 * Build a CompaniesRepo backed by a Db instance (for production use).
 * Tests inject a stub instead.
 */
export function createDbCompaniesRepo(db: Db): CompaniesRepo {
  return {
    async findByAtsBoardToken(ats, board_token) {
      const res = await db.query(
        `select id from companies where ats = $1 and board_token = $2 limit 1`,
        [ats, board_token],
      );
      return res.rows[0] ?? null;
    },

    async findByCareersUrl(careers_url) {
      const res = await db.query(
        `select id from companies where careers_url = $1 limit 1`,
        [careers_url],
      );
      return res.rows[0] ?? null;
    },

    async insert(row) {
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
  };
}
