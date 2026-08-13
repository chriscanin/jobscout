/**
 * Tests for apps/crawler/src/sources.ts (curated startup-intel sources).
 *
 * All tests use injected fakes — zero network, zero real LLM, zero DB.
 */

import { describe, it, expect } from "vitest";
import type { CuratedSourceKey, Logger } from "@jobscout/core";
import type { LlmClient, LlmRequest } from "../src/llm.js";
import {
  CURATED_SOURCES,
  contentHash,
  extractA16zNames,
  extractAnyCandidate,
  extractCompanies,
  extractFoundersFundNames,
  extractIndexNames,
  harmonicCandidateUrls,
  htmlToText,
  namesMatch,
  parseRssItems,
  parseYcCompanies,
  resolveCompanyBoard,
  runSources,
  slugCandidates,
  validateAnyBoard,
  type CuratedSourceDef,
  type SourcesRepo,
} from "../src/sources.js";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function makeLogger(): Logger & { errors: string[] } {
  const errors: string[] = [];
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (m: string) => errors.push(m),
    errors,
  };
}

/** LlmClient that returns a fixed companies array for every call. */
function makeLlm(companies: string[], calls: LlmRequest[] = []): LlmClient {
  return {
    label: "fake",
    async complete(req) {
      calls.push(req);
      return JSON.stringify({ companies });
    },
  };
}

/** In-memory SourcesRepo capturing all writes. */
function makeRepo() {
  const companies: Array<{
    name: string;
    ats: string;
    board_token: string | null;
    careers_url: string | null;
    discovered_via: string;
  }> = [];
  const items = new Map<string, { title: string | null; companies_found: number }>();
  const repo: SourcesRepo = {
    async findCompanyByAtsBoardToken(ats, token) {
      return companies.some((c) => c.ats === ats && c.board_token === token)
        ? { id: "existing" }
        : null;
    },
    async findCompanyByCareersUrl(url) {
      return companies.some((c) => c.careers_url === url) ? { id: "existing" } : null;
    },
    async insertCompany(row) {
      companies.push(row);
    },
    async hasItem(key, url) {
      return items.has(`${key}|${url}`);
    },
    async recordItem(row) {
      items.set(`${row.source_key}|${row.item_url}`, {
        title: row.title,
        companies_found: row.companies_found,
      });
    },
  };
  return { repo, companies, items };
}

/**
 * fetch fake routed by URL. Greenhouse/lever/ashby board-API URLs validate
 * only the tokens present in `boards` (returning the mapped company name).
 */
function makeFetch(routes: Record<string, { status: number; body: string }>) {
  const requested: string[] = [];
  const fetchFn = (async (input: string | URL) => {
    const url = String(input);
    requested.push(url);
    const route = routes[url];
    if (!route) {
      return new Response("not found", { status: 404 });
    }
    return new Response(route.body, { status: route.status });
  }) as typeof fetch;
  return { fetchFn, requested };
}

function greenhouseBoardBody(name: string): string {
  return JSON.stringify({ meta: { name }, jobs: [] });
}

const GH = (token: string) =>
  `https://boards-api.greenhouse.io/v1/boards/${token}/jobs`;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("pure helpers", () => {
  it("parseRssItems parses substack-style items (CDATA + content:encoded)", () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <title>next play</title>
      <item>
        <title><![CDATA[Should you join: Browserbase]]></title>
        <link>https://nextplayso.substack.com/p/browserbase</link>
        <content:encoded><![CDATA[<p>Browserbase is hiring engineers.</p>]]></content:encoded>
      </item>
      <item>
        <title>Plain title</title>
        <link>https://nextplayso.substack.com/p/two</link>
        <description>Fallback body</description>
      </item>
    </channel></rss>`;
    const items = parseRssItems(xml);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      title: "Should you join: Browserbase",
      link: "https://nextplayso.substack.com/p/browserbase",
      content: "<p>Browserbase is hiring engineers.</p>",
    });
    expect(items[1].content).toBe("Fallback body");
  });

  it("htmlToText strips tags/scripts and decodes entities", () => {
    const text = htmlToText(
      `<script>var x=1</script><h1>Hot&nbsp;25</h1><p>Resolve AI &amp; Lovable</p>`,
    );
    expect(text).toBe("Hot 25 Resolve AI & Lovable");
  });

  it("slugCandidates and namesMatch behave as documented", () => {
    expect(slugCandidates("Acme AI")).toEqual(["acmeai", "acme-ai"]);
    // No bare-first-word guess: blind probes stay near-exact.
    expect(slugCandidates("Rise Reforming")).toEqual(["risereforming", "rise-reforming"]);
    expect(namesMatch("Acme AI", "Acme AI, Inc.")).toBe(true);
    expect(namesMatch("acmeai", "Acme AI")).toBe(true);
    expect(namesMatch("Acme AI", "Zenith")).toBe(false);
  });

  it("contentHash is stable and content-sensitive", () => {
    expect(contentHash("abc")).toBe(contentHash("abc"));
    expect(contentHash("abc")).not.toBe(contentHash("abd"));
    expect(contentHash("abc")).toHaveLength(16);
  });

  it("harmonicCandidateUrls generates current + 2 prior quarters, both prefixes, newest first", () => {
    const urls = harmonicCandidateUrls(new Date(Date.UTC(2026, 0, 15))); // Q1 2026
    expect(urls).toEqual([
      "https://harmonic.ai/hot-25-startups/q1-2026",
      "https://harmonic.ai/hot-25-companies/q1-2026",
      "https://harmonic.ai/hot-25-startups/q4-2025",
      "https://harmonic.ai/hot-25-companies/q4-2025",
      "https://harmonic.ai/hot-25-startups/q3-2025",
      "https://harmonic.ai/hot-25-companies/q3-2025",
    ]);
  });

  it("parseYcCompanies reads yc-oss fields and tolerates junk", () => {
    const parsed = parseYcCompanies([
      {
        name: "Browserbase",
        website: "https://browserbase.com",
        batch: "Winter 2024",
        isHiring: true,
        url: "https://www.ycombinator.com/companies/browserbase",
      },
      { name: "NoFlag", website: null, isHiring: false },
      "junk",
      { notName: true },
    ]);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].isHiring).toBe(true);
    expect(parsed[1]).toMatchObject({ isHiring: false, website: null });
  });

  it("CURATED_SOURCES covers every curated key exactly once", () => {
    const keys = CURATED_SOURCES.map((s) => s.key).sort();
    expect(keys).toEqual(
      [
        "a16z-build",
        "early-days",
        "founders-you-should-know",
        "harmonic-hot25",
        "next-play",
        "ramp-vendor-report",
        "yc-directory",
        "vc-a16z",
        "vc-sequoia",
        "vc-index",
        "vc-founders-fund",
        "tc-funding",
        "product-hunt",
        "pragmatic-engineer",
        "startup-lists",
      ].sort() as CuratedSourceKey[],
    );
  });

  it("parseRssItems parses Atom entries (Product Hunt style)", () => {
    const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <title>Product Hunt</title>
      <entry>
        <title>Acme AI - Agents for accountants</title>
        <link rel="alternate" href="https://www.producthunt.com/posts/acme-ai"/>
        <content type="html">&lt;p&gt;Acme AI launches today&lt;/p&gt;</content>
      </entry>
    </feed>`;
    const items = parseRssItems(atom);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Acme AI - Agents for accountants");
    expect(items[0].link).toBe("https://www.producthunt.com/posts/acme-ai");
  });

  it("deterministic extractors pull names from structured portfolio pages", () => {
    expect(
      extractA16zNames(
        `<div data-company='{"id":1,"name":"figma","display_name":"Figma"}'></div>` +
          `<div data-company='{"id":2,"name":"anduril"}'></div>` +
          `<div data-company='broken'></div>`,
      ),
    ).toEqual(["Figma", "anduril"]);

    expect(
      extractIndexNames(
        `<script type="application/ld+json">{"@type":"ItemList","itemListElement":[` +
          `{"@type":"ListItem","position":1,"url":"https://x/figma/","name":"Figma"},` +
          `{"@type":"ListItem","position":2,"url":"https://x/wiz/","name":"Wiz"}]}</script>`,
      ),
    ).toEqual(["Figma", "Wiz"]);

    expect(
      extractFoundersFundNames(
        `{"type":"company","link":"https://foundersfund.com/company/anduril/","title":{"rendered":"Anduril"}},` +
          `{"type":"company","link":"https://foundersfund.com/company/stripe/","title":{"rendered":"Stripe"}}`,
      ),
    ).toEqual(["Anduril", "Stripe"]);
  });
});

// ---------------------------------------------------------------------------
// extractAnyCandidate + validateAnyBoard (six-ATS resolution)
// ---------------------------------------------------------------------------

describe("six-ATS resolution", () => {
  it("extractAnyCandidate recognises all six board URL shapes", () => {
    expect(extractAnyCandidate("https://job-boards.greenhouse.io/stripe/jobs/1")).toEqual({
      ats: "greenhouse",
      board_token: "stripe",
    });
    expect(extractAnyCandidate("https://careers.smartrecruiters.com/Visa/123")).toEqual({
      ats: "smartrecruiters",
      board_token: "visa",
    });
    expect(extractAnyCandidate("https://jobs.smartrecruiters.com/Bosch")).toEqual({
      ats: "smartrecruiters",
      board_token: "bosch",
    });
    expect(extractAnyCandidate("https://apply.workable.com/blueground/j/ABC/")).toEqual({
      ats: "workable",
      board_token: "blueground",
    });
    expect(extractAnyCandidate("https://bunq.recruitee.com/o/backend-dev")).toEqual({
      ats: "recruitee",
      board_token: "bunq",
    });
    expect(extractAnyCandidate("https://example.com/careers")).toBeNull();
    expect(extractAnyCandidate("https://apply.workable.com/api/v1/x")).toBeNull();
  });

  it("validateAnyBoard validates the three new ATS endpoints", async () => {
    const { fetchFn } = makeFetch({
      "https://api.smartrecruiters.com/v1/companies/visa/postings?limit=1": {
        status: 200,
        body: JSON.stringify({
          totalFound: 2,
          content: [{ company: { name: "Visa" } }],
        }),
      },
      "https://api.smartrecruiters.com/v1/companies/ghost/postings?limit=1": {
        status: 200,
        body: JSON.stringify({ totalFound: 0, content: [] }),
      },
      "https://apply.workable.com/api/v1/widget/accounts/blueground": {
        status: 200,
        body: JSON.stringify({ name: "Blueground", jobs: [] }),
      },
      "https://bunq.recruitee.com/api/offers/": {
        status: 200,
        body: JSON.stringify({ offers: [{ company_name: "bunq" }] }),
      },
    });

    expect(await validateAnyBoard(fetchFn, "smartrecruiters", "visa")).toEqual({
      valid: true,
      name: "Visa",
    });
    // 200 with totalFound 0 is an unknown/empty identifier, not a board.
    expect(await validateAnyBoard(fetchFn, "smartrecruiters", "ghost")).toEqual({
      valid: false,
    });
    expect(await validateAnyBoard(fetchFn, "workable", "blueground")).toEqual({
      valid: true,
      name: "Blueground",
    });
    expect(await validateAnyBoard(fetchFn, "recruitee", "bunq")).toEqual({
      valid: true,
      name: "bunq",
    });
    expect(await validateAnyBoard(fetchFn, "workable", "nope")).toEqual({ valid: false });
  });

  it("resolveCompanyBoard resolves onto a new ATS via slug probe", async () => {
    const { fetchFn } = makeFetch({
      "https://apply.workable.com/api/v1/widget/accounts/blueground": {
        status: 200,
        body: JSON.stringify({ name: "Blueground", jobs: [] }),
      },
    });
    const resolved = await resolveCompanyBoard("Blueground", {
      fetchFn,
      logger: makeLogger(),
    });
    expect(resolved).toEqual({
      ats: "workable",
      board_token: "blueground",
      name: "Blueground",
    });
  });
});

// ---------------------------------------------------------------------------
// html sources — structured extraction + multi-candidate batches
// ---------------------------------------------------------------------------

describe("runSources — structured html", () => {
  it("uses the deterministic extractor, skips the LLM, and processes every reachable candidate", async () => {
    const { repo, companies } = makeRepo();
    const llmCalls: unknown[] = [];
    const llm: LlmClient = {
      label: "spy",
      complete: async (req) => {
        llmCalls.push(req);
        return JSON.stringify({ companies: [] });
      },
    };
    const source: CuratedSourceDef = {
      key: "vc-a16z",
      label: "a16z portfolio",
      kind: "html",
      url: "unused",
      candidateUrls: () => ["https://a16z.com/portfolio/", "https://a16z.com/gone/"],
      extractNames: extractA16zNames,
    };
    const { fetchFn } = makeFetch({
      "https://a16z.com/portfolio/": {
        status: 200,
        body: `<div data-company='{"display_name":"Browserbase"}'></div>`,
      },
      [GH("browserbase")]: { status: 200, body: greenhouseBoardBody("Browserbase") },
    });

    const stats = await runSources({
      sources: [source],
      fetchFn,
      llm,
      repo,
      logger: makeLogger(),
    });
    expect(stats[0]).toMatchObject({ items: 1, newItems: 1, extracted: 1, inserted: 1 });
    expect(llmCalls).toHaveLength(0); // structured extraction bypassed the LLM
    expect(companies[0]).toMatchObject({
      name: "Browserbase",
      discovered_via: "vc-a16z",
    });
  });
});

// ---------------------------------------------------------------------------
// extractCompanies
// ---------------------------------------------------------------------------

describe("extractCompanies", () => {
  it("dedups case-insensitively and drops blanks", async () => {
    const llm = makeLlm(["Browserbase", "browserbase", " ", "Lovable"]);
    const names = await extractCompanies(llm, "test", "text");
    expect(names).toEqual(["Browserbase", "Lovable"]);
  });

  it("returns [] on non-JSON output", async () => {
    const llm: LlmClient = {
      label: "bad",
      complete: async () => "sorry, no",
    };
    expect(await extractCompanies(llm, "test", "text")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveCompanyBoard
// ---------------------------------------------------------------------------

describe("resolveCompanyBoard", () => {
  it("resolves via slug probe when the board name matches", async () => {
    const { fetchFn } = makeFetch({
      [GH("browserbase")]: { status: 200, body: greenhouseBoardBody("Browserbase") },
    });
    const resolved = await resolveCompanyBoard("Browserbase", {
      fetchFn,
      logger: makeLogger(),
    });
    expect(resolved).toEqual({
      ats: "greenhouse",
      board_token: "browserbase",
      name: "Browserbase",
    });
  });

  it("rejects a slug collision (board name does not match) and falls to search", async () => {
    const { fetchFn } = makeFetch({
      // "acme" exists on greenhouse but belongs to someone else entirely
      [GH("acme")]: { status: 200, body: greenhouseBoardBody("Association of Corporate Metal Engineers") },
      [GH("acme-robotics")]: { status: 200, body: greenhouseBoardBody("Acme Robotics") },
    });
    const searchClient = {
      async search() {
        return [
          {
            url: "https://job-boards.greenhouse.io/acme-robotics/jobs/1",
            title: "Jobs at Acme Robotics",
          },
        ];
      },
    };
    const resolved = await resolveCompanyBoard("Acme Robotics", {
      fetchFn,
      searchClient,
      logger: makeLogger(),
    });
    expect(resolved).toEqual({
      ats: "greenhouse",
      board_token: "acme-robotics",
      name: "Acme Robotics",
    });
  });

  it("returns null when nothing validates and no search client is given", async () => {
    const { fetchFn } = makeFetch({});
    const resolved = await resolveCompanyBoard("Ghost Startup", {
      fetchFn,
      logger: makeLogger(),
    });
    expect(resolved).toBeNull();
  });

  it("throws when the search client errors (so the item retries next run)", async () => {
    const { fetchFn } = makeFetch({});
    const searchClient = {
      async search(): Promise<{ url: string; title: string }[]> {
        throw new Error("401 invalid x-api-key");
      },
    };
    await expect(
      resolveCompanyBoard("Ghost Startup", {
        fetchFn,
        searchClient,
        logger: makeLogger(),
      }),
    ).rejects.toThrow(/web search failed/);
  });
});

// ---------------------------------------------------------------------------
// runSources — rss
// ---------------------------------------------------------------------------

const RSS_SOURCE: CuratedSourceDef = {
  key: "next-play",
  label: "Next Play newsletter",
  kind: "rss",
  url: "https://nextplayso.substack.com/feed",
};

const FEED_XML = `<rss><channel>
  <item>
    <title><![CDATA[Should you join: Browserbase]]></title>
    <link>https://nextplayso.substack.com/p/browserbase</link>
    <content:encoded><![CDATA[<p>Browserbase is a breakout startup hiring now.</p>]]></content:encoded>
  </item>
</rss></channel>`;

describe("runSources — rss", () => {
  it("extracts, resolves, inserts, records the item, and is idempotent", async () => {
    const { repo, companies, items } = makeRepo();
    const { fetchFn } = makeFetch({
      [RSS_SOURCE.url]: { status: 200, body: FEED_XML },
      [GH("browserbase")]: { status: 200, body: greenhouseBoardBody("Browserbase") },
    });
    const deps = {
      sources: [RSS_SOURCE],
      fetchFn,
      llm: makeLlm(["Browserbase"]),
      repo,
      logger: makeLogger(),
    };

    const stats1 = await runSources(deps);
    expect(stats1[0]).toMatchObject({
      source: "next-play",
      items: 1,
      newItems: 1,
      extracted: 1,
      inserted: 1,
      skippedKnown: 0,
      unresolved: 0,
      errors: [],
    });
    expect(companies).toEqual([
      {
        name: "Browserbase",
        ats: "greenhouse",
        board_token: "browserbase",
        careers_url: null,
        discovered_via: "next-play",
        active: true,
      },
    ]);
    expect(items.has("next-play|https://nextplayso.substack.com/p/browserbase")).toBe(true);

    // Second run: the item is recorded, so nothing is reprocessed.
    const stats2 = await runSources(deps);
    expect(stats2[0]).toMatchObject({ items: 1, newItems: 0, inserted: 0 });
    expect(companies).toHaveLength(1);
  });

  it("counts unresolved names without inserting and isolates a failing source", async () => {
    const { repo, companies } = makeRepo();
    const { fetchFn } = makeFetch({
      [RSS_SOURCE.url]: { status: 200, body: FEED_XML },
      // no board endpoints — resolution fails
    });
    const failing: CuratedSourceDef = {
      key: "early-days",
      label: "Early Days",
      kind: "rss",
      url: "https://earlydaysbymerlin.substack.com/feed", // 404s in makeFetch
    };
    const stats = await runSources({
      sources: [failing, RSS_SOURCE],
      fetchFn,
      llm: makeLlm(["GhostCo"]),
      repo,
      logger: makeLogger(),
    });
    // Failing source recorded an error but did not kill the run.
    expect(stats[0].errors).toHaveLength(1);
    expect(stats[1]).toMatchObject({ unresolved: 1, inserted: 0, errors: [] });
    expect(companies).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runSources — html (content-hash idempotency)
// ---------------------------------------------------------------------------

describe("runSources — html", () => {
  const HTML_SOURCE: CuratedSourceDef = {
    key: "harmonic-hot25",
    label: "Harmonic Hot 25",
    kind: "html",
    url: "unused",
    candidateUrls: () => [
      "https://harmonic.ai/hot-25-startups/q3-2026",
      "https://harmonic.ai/hot-25-startups/q2-2026",
    ],
  };

  it("uses the first reachable candidate URL and reprocesses only on content change", async () => {
    const { repo, companies } = makeRepo();
    const routes: Record<string, { status: number; body: string }> = {
      // q3 not yet published; q2 live
      "https://harmonic.ai/hot-25-startups/q2-2026": {
        status: 200,
        body: "<div>Lovable</div>",
      },
      [GH("lovable")]: { status: 200, body: greenhouseBoardBody("Lovable") },
    };
    const { fetchFn } = makeFetch(routes);
    const deps = {
      sources: [HTML_SOURCE],
      fetchFn,
      llm: makeLlm(["Lovable"]),
      repo,
      logger: makeLogger(),
    };

    const stats1 = await runSources(deps);
    expect(stats1[0]).toMatchObject({ newItems: 1, inserted: 1 });
    expect(companies[0].discovered_via).toBe("harmonic-hot25");

    // Unchanged page: skipped.
    const stats2 = await runSources(deps);
    expect(stats2[0]).toMatchObject({ newItems: 0 });

    // Changed page content: reprocessed (company dedup prevents re-insert).
    routes["https://harmonic.ai/hot-25-startups/q2-2026"].body =
      "<div>Lovable and friends</div>";
    const stats3 = await runSources(deps);
    expect(stats3[0]).toMatchObject({ newItems: 1, inserted: 0, skippedKnown: 1 });
  });
});

// ---------------------------------------------------------------------------
// runSources — yc
// ---------------------------------------------------------------------------

describe("runSources — yc", () => {
  const YC_SOURCE: CuratedSourceDef = {
    key: "yc-directory",
    label: "YC startup directory",
    kind: "yc",
    url: "https://yc-oss.github.io/api/companies/hiring.json",
  };

  it("inserts resolved boards, falls back to ats=unknown with website, and is per-company idempotent", async () => {
    const { repo, companies, items } = makeRepo();
    const ycBody = JSON.stringify([
      {
        name: "Browserbase",
        website: "https://browserbase.com",
        batch: "Winter 2024",
        isHiring: true,
        url: "https://www.ycombinator.com/companies/browserbase",
      },
      {
        name: "NoBoard Labs",
        website: "https://noboard.example",
        batch: "Summer 2026",
        isHiring: true,
        url: "https://www.ycombinator.com/companies/noboard-labs",
      },
      { name: "NotHiring", website: "https://x.example", isHiring: false, url: "u" },
    ]);
    const { fetchFn } = makeFetch({
      [YC_SOURCE.url]: { status: 200, body: ycBody },
      [GH("browserbase")]: { status: 200, body: greenhouseBoardBody("Browserbase") },
    });
    const deps = {
      sources: [YC_SOURCE],
      fetchFn,
      llm: makeLlm([]),
      repo,
      logger: makeLogger(),
    };

    const stats1 = await runSources(deps);
    expect(stats1[0]).toMatchObject({
      items: 2, // hiring only
      newItems: 2,
      inserted: 2,
      unresolved: 0,
      errors: [],
    });
    const byName = Object.fromEntries(companies.map((c) => [c.name, c]));
    expect(byName["Browserbase"]).toMatchObject({
      ats: "greenhouse",
      board_token: "browserbase",
      discovered_via: "yc-directory",
    });
    expect(byName["NoBoard Labs"]).toMatchObject({
      ats: "unknown",
      board_token: null,
      careers_url: "https://noboard.example",
    });
    expect(items.size).toBe(2);

    // Second run: every company already has a source_items row.
    const stats2 = await runSources(deps);
    expect(stats2[0]).toMatchObject({ newItems: 0, inserted: 0 });
  });
});
