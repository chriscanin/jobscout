/**
 * Tests for apps/crawler/src/discovery.ts
 *
 * All tests use injected mocks — zero network calls.
 * Covers all 8 scenarios from spec 04.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  extractCandidate,
  buildDiscoveryQueries,
  runDiscovery,
  type SearchClient,
  type CompaniesRepo,
  type DiscoveryStats,
} from "../src/discovery.js";
import { DEFAULT_CRITERIA, type Criteria } from "@jobscout/core";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

function loadFixtureJson(rel: string): unknown {
  const full = path.join(FIXTURES_DIR, rel);
  return JSON.parse(readFileSync(full, "utf8"));
}

function loadFixtureText(rel: string): string {
  return readFileSync(path.join(FIXTURES_DIR, rel), "utf8");
}

// ---------------------------------------------------------------------------
// Logger stub
// ---------------------------------------------------------------------------

function makeLogger() {
  const infos: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  const debugs: string[] = [];
  return {
    debug: (m: string) => debugs.push(m),
    info: (m: string) => infos.push(m),
    warn: (m: string) => warns.push(m),
    error: (m: string) => errors.push(m),
    infos, warns, errors, debugs,
  };
}

// ---------------------------------------------------------------------------
// Scenario 1: extractCandidate — all four URL shapes
// ---------------------------------------------------------------------------

describe("Scenario 1: extractCandidate — all four URL shapes", () => {
  it("extracts greenhouse board_token from job-boards.greenhouse.io URL", () => {
    const result = extractCandidate(
      "https://job-boards.greenhouse.io/mattermost/jobs/5238290008",
    );
    expect(result).toEqual({
      kind: "board",
      ats: "greenhouse",
      board_token: "mattermost",
    });
  });

  it("extracts greenhouse board_token from boards.greenhouse.io URL", () => {
    const result = extractCandidate("https://boards.greenhouse.io/acmeco");
    expect(result).toEqual({
      kind: "board",
      ats: "greenhouse",
      board_token: "acmeco",
    });
  });

  it("extracts lever board_token from jobs.lever.co URL (drops job UUID)", () => {
    const result = extractCandidate(
      "https://jobs.lever.co/plaid/9c9e1cf5-0000-0000-0000-000000000000",
    );
    expect(result).toEqual({
      kind: "board",
      ats: "lever",
      board_token: "plaid",
    });
  });

  it("extracts ashby board_token from jobs.ashbyhq.com URL", () => {
    const result = extractCandidate(
      "https://jobs.ashbyhq.com/linear/frontend-engineer",
    );
    expect(result).toEqual({
      kind: "board",
      ats: "ashby",
      board_token: "linear",
    });
  });

  it("returns kind=page for an unrecognised URL", () => {
    const url = "https://careers.somecompany.com/jobs";
    const result = extractCandidate(url);
    expect(result).toEqual({ kind: "page", url });
  });

  it("lowercases board tokens", () => {
    const result = extractCandidate(
      "https://job-boards.greenhouse.io/AcmeCO/jobs/123",
    );
    expect(result).toEqual({
      kind: "board",
      ats: "greenhouse",
      board_token: "acmeco",
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Validated new board is inserted (happy path end-to-end)
// ---------------------------------------------------------------------------

describe("Scenario 2: Validated new board is inserted", () => {
  it("inserts a new greenhouse company row when board API returns 200", async () => {
    // Load the greenhouse search fixture and extract URLs
    const fixture = loadFixtureJson(
      "discovery/web-search-greenhouse-react-native.json",
    ) as { results: { url: string; title: string }[] };

    const boardFixture = loadFixtureJson("greenhouse/board-mattermost.json") as {
      meta: { name: string };
      jobs: unknown[];
    };

    const searchClient: SearchClient = {
      search: async () => fixture.results,
    };

    const inserted: Parameters<CompaniesRepo["insert"]>[0][] = [];
    const companies: CompaniesRepo = {
      findByAtsBoardToken: async () => null,
      findByCareersUrl: async () => null,
      insert: async (row) => { inserted.push(row); },
    };

    // fetchFn: serve board fixture for greenhouse validation URLs, 404 otherwise
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes("boards-api.greenhouse.io")) {
        return new Response(JSON.stringify(boardFixture), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const logger = makeLogger();
    const stats = await runDiscovery({
      searchClient,
      fetchFn: fetchFn as unknown as typeof fetch,
      companies,
      criteria: DEFAULT_CRITERIA,
      logger,
    });

    // At least one insert for mattermost
    const mattermostInsert = inserted.find(
      (r) => r.ats === "greenhouse" && r.board_token === "mattermost",
    );
    expect(mattermostInsert).toBeDefined();
    expect(mattermostInsert?.discovered_via).toBe("web-search");
    expect(mattermostInsert?.active).toBe(true);
    expect(mattermostInsert?.name.length).toBeGreaterThan(0);
    expect(stats.inserted).toBeGreaterThanOrEqual(1);
    expect(stats.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Already-known board is not re-inserted
// ---------------------------------------------------------------------------

describe("Scenario 3: Already-known (ats, board_token) is not re-inserted", () => {
  it("skips known boards and does not call the board API for them", async () => {
    const fixture = loadFixtureJson(
      "discovery/web-search-greenhouse-react-native.json",
    ) as { results: { url: string; title: string }[] };

    const searchClient: SearchClient = {
      search: async () => fixture.results,
    };

    const fetchFn = vi.fn(async (_url: string) =>
      new Response("", { status: 200 }),
    );

    const inserted: unknown[] = [];
    const companies: CompaniesRepo = {
      // All greenhouse tokens are already known
      findByAtsBoardToken: async (ats, board_token) => {
        if (ats === "greenhouse") return { id: "existing-id" };
        return null;
      },
      findByCareersUrl: async () => null,
      insert: async (row) => { inserted.push(row); },
    };

    const logger = makeLogger();
    const stats = await runDiscovery({
      searchClient,
      fetchFn: fetchFn as unknown as typeof fetch,
      companies,
      criteria: DEFAULT_CRITERIA,
      logger,
    });

    // No greenhouse inserts
    expect(inserted.find((r: any) => r.ats === "greenhouse")).toBeUndefined();
    // skippedKnown should be >= 1
    expect(stats.skippedKnown).toBeGreaterThanOrEqual(1);
    // Board API was NOT called for the known mattermost board
    const boardApiCalls = fetchFn.mock.calls.filter(([url]) =>
      typeof url === "string" && url.includes("boards-api.greenhouse.io/v1/boards/mattermost"),
    );
    expect(boardApiCalls).toHaveLength(0);
    expect(stats.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Board API returns 404 — candidate not inserted
// ---------------------------------------------------------------------------

describe("Scenario 4: Board API 404 does not insert", () => {
  it("marks invalid when board API returns 404, continues to process other candidates", async () => {
    // ghosttown returns 404; acmeco returns 200
    const searchClient: SearchClient = {
      search: async () => [
        { url: "https://boards.greenhouse.io/ghosttown", title: "Ghost Town Jobs" },
        { url: "https://boards.greenhouse.io/acmeco", title: "Acme Jobs" },
      ],
    };

    const boardAcmeFixture = { meta: { name: "Acme Co" }, jobs: [] };

    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes("/ghosttown/")) return new Response("not found", { status: 404 });
      if (url.includes("/acmeco/")) return new Response(JSON.stringify(boardAcmeFixture), { status: 200 });
      return new Response("", { status: 404 });
    });

    const inserted: Parameters<CompaniesRepo["insert"]>[0][] = [];
    const companies: CompaniesRepo = {
      findByAtsBoardToken: async () => null,
      findByCareersUrl: async () => null,
      insert: async (row) => { inserted.push(row); },
    };

    const logger = makeLogger();
    const stats = await runDiscovery({
      searchClient,
      fetchFn: fetchFn as unknown as typeof fetch,
      companies,
      criteria: DEFAULT_CRITERIA,
      logger,
    });

    // ghosttown should not be inserted
    expect(inserted.find((r) => r.board_token === "ghosttown")).toBeUndefined();
    expect(stats.invalid).toBeGreaterThanOrEqual(1);

    // acmeco should be inserted (run continues after ghosttown failure)
    expect(inserted.find((r) => r.board_token === "acmeco")).toBeDefined();
    expect(stats.inserted).toBeGreaterThanOrEqual(1);

    // No thrown errors
    expect(stats.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: Generic page with lever link resolves to lever company
// ---------------------------------------------------------------------------

describe("Scenario 5: Generic careers page with lever link", () => {
  it("inserts a lever row (not ats=other) when page contains a jobs.lever.co link", async () => {
    const pageUrl = "https://careers.example-startup.com/jobs";
    const leverFixture = loadFixtureJson("lever/postings-valid-site.json");
    const leverHtml = loadFixtureText("discovery/careers-page-with-lever-link.html");

    const searchClient: SearchClient = {
      search: async () => [{ url: pageUrl, title: "Jobs at Example Startup" }],
    };

    const fetchFn = vi.fn(async (url: string) => {
      // robots.txt: allow everything
      if (url.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nDisallow:\n", { status: 200 });
      }
      // The careers page
      if (url === pageUrl) {
        return new Response(leverHtml, { status: 200 });
      }
      // Lever board validation
      if (url.includes("api.lever.co/v0/postings/exampleco")) {
        return new Response(JSON.stringify(leverFixture), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const inserted: Parameters<CompaniesRepo["insert"]>[0][] = [];
    const companies: CompaniesRepo = {
      findByAtsBoardToken: async () => null,
      findByCareersUrl: async () => null,
      insert: async (row) => { inserted.push(row); },
    };

    const logger = makeLogger();
    const stats = await runDiscovery({
      searchClient,
      fetchFn: fetchFn as unknown as typeof fetch,
      companies,
      criteria: DEFAULT_CRITERIA,
      logger,
    });

    const leverInsert = inserted.find(
      (r) => r.ats === "lever" && r.board_token === "exampleco",
    );
    expect(leverInsert).toBeDefined();
    expect(leverInsert?.discovered_via).toBe("web-search");
    expect(leverInsert?.active).toBe(true);

    // No ats=other row for this page
    const otherInsert = inserted.find((r) => r.ats === "other");
    expect(otherInsert).toBeUndefined();

    expect(stats.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: Unrecognisable page becomes ats=other; second run skips it
// ---------------------------------------------------------------------------

describe("Scenario 6: Unrecognisable page becomes ats=other", () => {
  it("inserts ats=other on first run, skips on second run", async () => {
    const pageUrl = "https://www.unknowncompany.example.com/careers";
    const noAtsHtml = loadFixtureText("discovery/careers-page-no-ats.html");

    const searchClient: SearchClient = {
      search: async () => [{ url: pageUrl, title: "Work With Us" }],
    };

    const makeFetch = () =>
      vi.fn(async (url: string) => {
        if (url.endsWith("/robots.txt")) {
          return new Response("User-agent: *\nDisallow:\n", { status: 200 });
        }
        if (url === pageUrl) {
          return new Response(noAtsHtml, { status: 200 });
        }
        return new Response("not found", { status: 404 });
      });

    // First run: empty repo
    const firstInserted: Parameters<CompaniesRepo["insert"]>[0][] = [];
    const companiesFirst: CompaniesRepo = {
      findByAtsBoardToken: async () => null,
      findByCareersUrl: async () => null,
      insert: async (row) => { firstInserted.push(row); },
    };

    const logger1 = makeLogger();
    const stats1 = await runDiscovery({
      searchClient,
      fetchFn: makeFetch() as unknown as typeof fetch,
      companies: companiesFirst,
      criteria: DEFAULT_CRITERIA,
      logger: logger1,
    });

    expect(stats1.other).toBe(1);
    expect(stats1.inserted).toBe(1);

    const otherRow = firstInserted.find((r) => r.ats === "other");
    expect(otherRow).toBeDefined();
    expect(otherRow?.board_token).toBeNull();
    expect(otherRow?.careers_url).toBe(pageUrl);
    expect(otherRow?.discovered_via).toBe("web-search");
    expect(otherRow?.active).toBe(true);
    expect(otherRow?.name.length).toBeGreaterThan(0);

    // Second run: repo already has the careers_url
    const secondInserted: Parameters<CompaniesRepo["insert"]>[0][] = [];
    const companiesSecond: CompaniesRepo = {
      findByAtsBoardToken: async () => null,
      findByCareersUrl: async (url) => url === pageUrl ? { id: "existing" } : null,
      insert: async (row) => { secondInserted.push(row); },
    };

    const logger2 = makeLogger();
    const stats2 = await runDiscovery({
      searchClient,
      fetchFn: makeFetch() as unknown as typeof fetch,
      companies: companiesSecond,
      criteria: DEFAULT_CRITERIA,
      logger: logger2,
    });

    expect(secondInserted.find((r) => r.ats === "other")).toBeUndefined();
    expect(stats2.inserted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 7: 8-search budget is never exceeded
// ---------------------------------------------------------------------------

describe("Scenario 7: 8-search budget is never exceeded", () => {
  it("buildDiscoveryQueries returns at most 8 queries with default criteria", () => {
    const queries = buildDiscoveryQueries(DEFAULT_CRITERIA);
    expect(queries.length).toBeLessThanOrEqual(8);
    expect(queries.length).toBeGreaterThan(0);
  });

  it("buildDiscoveryQueries returns <= 8 queries even with many keywords", () => {
    const manyKeywordCriteria: Criteria = {
      ...DEFAULT_CRITERIA,
      role_priorities: [
        {
          category: "react-native",
          priority: 1,
          keywords: [
            "react native", "mobile developer", "mobile engineer", "expo",
            "ios engineer", "android engineer", "rn developer", "rn engineer",
            "react-native developer", "mobile app engineer",
          ],
        },
        {
          category: "react",
          priority: 2,
          keywords: [
            "react developer", "react engineer", "react.js", "reactjs",
            "frontend react", "react frontend",
          ],
        },
      ],
    };
    const queries = buildDiscoveryQueries(manyKeywordCriteria);
    expect(queries.length).toBeLessThanOrEqual(8);
  });

  it("runDiscovery makes exactly as many search calls as queries (never > 8)", async () => {
    const callCount = { n: 0 };
    const searchClient: SearchClient = {
      search: async () => {
        callCount.n++;
        return [];
      },
    };

    const companies: CompaniesRepo = {
      findByAtsBoardToken: async () => null,
      findByCareersUrl: async () => null,
      insert: async () => {},
    };

    const logger = makeLogger();
    const stats = await runDiscovery({
      searchClient,
      fetchFn: (async () => new Response("", { status: 200 })) as unknown as typeof fetch,
      companies,
      criteria: DEFAULT_CRITERIA,
      logger,
    });

    const expectedQueryCount = buildDiscoveryQueries(DEFAULT_CRITERIA).length;
    expect(stats.searches).toBe(expectedQueryCount);
    expect(callCount.n).toBe(expectedQueryCount);
    expect(callCount.n).toBeLessThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// Scenario 8: robots.txt disallow blocks the generic page fetch
// ---------------------------------------------------------------------------

describe("Scenario 8: robots.txt disallow blocks page fetch", () => {
  it("does not fetch a page whose path is disallowed by robots.txt", async () => {
    const pageUrl = "https://blocked-company.example.com/careers/openings";
    const robotsTxt = loadFixtureText("discovery/robots-disallow.txt");

    const fetchedUrls: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      fetchedUrls.push(url);
      if (url.endsWith("/robots.txt")) {
        return new Response(robotsTxt, { status: 200 });
      }
      // careers page should never be reached
      return new Response("<html><title>Jobs</title></html>", { status: 200 });
    });

    const searchClient: SearchClient = {
      search: async () => [{ url: pageUrl, title: "Careers" }],
    };

    const inserted: unknown[] = [];
    const companies: CompaniesRepo = {
      findByAtsBoardToken: async () => null,
      findByCareersUrl: async () => null,
      insert: async (row) => { inserted.push(row); },
    };

    const logger = makeLogger();
    const stats = await runDiscovery({
      searchClient,
      fetchFn: fetchFn as unknown as typeof fetch,
      companies,
      criteria: DEFAULT_CRITERIA,
      logger,
    });

    // The actual page URL must NOT have been fetched
    expect(fetchedUrls).not.toContain(pageUrl);

    // No companies row inserted
    expect(inserted).toHaveLength(0);

    // Run exits normally (no throw), robots block recorded in errors or logs
    const robotsBlocked =
      stats.errors.some((e) => e.includes(pageUrl)) ||
      logger.infos.some((m) => m.includes(pageUrl));
    expect(robotsBlocked).toBe(true);
  });
});
