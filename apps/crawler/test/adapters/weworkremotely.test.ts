/**
 * Tests for the We Work Remotely adapter.
 *
 * Scenarios covered:
 *  1. Happy path: RSS items map to RawJobs ("Company: Role" title splitting,
 *     <region> → location, pubDate → ISO)
 *  2. Title without ": " keeps the whole title
 *  3. Non-200 response → recordError called, [] returned, no throw
 *
 * All tests run fully offline: ctx.fetch is stubbed from inline fixtures.
 */

import { describe, it, expect, vi } from "vitest";
import { weworkremotelyAdapter } from "../../src/adapters/weworkremotely.js";
import { buildTestCtx } from "../helpers/ctx.js";

// Stub global fetch to throw — any adapter bypassing ctx.fetch will fail
vi.stubGlobal("fetch", () => {
  throw new Error("Global fetch must not be called in tests — use ctx.fetch");
});

const FEED_URL =
  "https://weworkremotely.com/categories/remote-programming-jobs.rss";

// ---------------------------------------------------------------------------
// Inline fixture
// ---------------------------------------------------------------------------

const feedXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>We Work Remotely: Remote Programming Jobs</title>
    <link>https://weworkremotely.com/categories/remote-programming-jobs</link>
    <item>
      <title><![CDATA[Lumen &amp; Sons: Senior React Native Engineer]]></title>
      <region><![CDATA[Anywhere in the World]]></region>
      <category>remote-programming-jobs</category>
      <guid>https://weworkremotely.com/remote-jobs/lumen-sons-senior-react-native-engineer</guid>
      <link>https://weworkremotely.com/remote-jobs/lumen-sons-senior-react-native-engineer</link>
      <pubDate>Tue, 28 Jul 2026 12:00:00 +0000</pubDate>
      <description><![CDATA[<p>Build cross-platform apps with Expo.</p>]]></description>
    </item>
    <item>
      <title><![CDATA[Untitled Posting Without Colon]]></title>
      <region><![CDATA[USA Only]]></region>
      <category>remote-programming-jobs</category>
      <guid>https://weworkremotely.com/remote-jobs/untitled-posting</guid>
      <link>https://weworkremotely.com/remote-jobs/untitled-posting</link>
      <pubDate>Mon, 27 Jul 2026 09:30:00 +0000</pubDate>
      <description><![CDATA[<p>Mystery role.</p>]]></description>
    </item>
  </channel>
</rss>`;

// ---------------------------------------------------------------------------
// Scenario 1: happy path — title splitting and field mapping
// ---------------------------------------------------------------------------

describe("Scenario 1: WWR RSS items map to RawJobs", () => {
  it("splits 'Company: Role' titles and maps all fields", async () => {
    const ctx = buildTestCtx({
      fixtures: {
        [FEED_URL]: new Response(feedXml, { status: 200 }),
      },
    });

    const jobs = await weworkremotelyAdapter.fetchJobs(ctx);

    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.source === "weworkremotely")).toBe(true);
    expect(ctx.recordedErrors).toHaveLength(0);

    const job = jobs[0];
    expect(job.externalId).toBe(
      "https://weworkremotely.com/remote-jobs/lumen-sons-senior-react-native-engineer",
    );
    expect(job.url).toBe(
      "https://weworkremotely.com/remote-jobs/lumen-sons-senior-react-native-engineer",
    );
    // Title split on the first ": " — entities decoded
    expect(job.company).toBe("Lumen & Sons");
    expect(job.title).toBe("Senior React Native Engineer");
    expect(job.location).toBe("Anywhere in the World");
    expect(job.description).toBe("<p>Build cross-platform apps with Expo.</p>");
    // pubDate parsed to ISO
    expect(job.postedAt).toBe("2026-07-28T12:00:00.000Z");
  });

  it("keeps the whole title when there is no ': ' separator", async () => {
    const ctx = buildTestCtx({
      fixtures: {
        [FEED_URL]: new Response(feedXml, { status: 200 }),
      },
    });

    const jobs = await weworkremotelyAdapter.fetchJobs(ctx);
    const job = jobs[1];

    expect(job.title).toBe("Untitled Posting Without Colon");
    expect(job.company).toBe("Untitled Posting Without Colon");
    expect(job.location).toBe("USA Only");
    expect(job.postedAt).toBe("2026-07-27T09:30:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: failure path — recordError, [] returned, nothing thrown
// ---------------------------------------------------------------------------

describe("Scenario 2: failure paths record errors and return []", () => {
  it("non-200 response → recordError called, [] returned", async () => {
    const ctx = buildTestCtx({
      fixtures: {
        [FEED_URL]: new Response("gone", { status: 502 }),
      },
    });

    await expect(weworkremotelyAdapter.fetchJobs(ctx)).resolves.toEqual([]);
    expect(ctx.recordedErrors).toHaveLength(1);
    expect(ctx.recordedErrors[0]).toContain("weworkremotely");
    expect(ctx.recordedErrors[0]).toContain("502");
  });

  it("feed with no items returns [] without recording errors", async () => {
    const emptyFeed = `<?xml version="1.0"?><rss version="2.0"><channel><title>Empty</title></channel></rss>`;
    const ctx = buildTestCtx({
      fixtures: {
        [FEED_URL]: new Response(emptyFeed, { status: 200 }),
      },
    });

    await expect(weworkremotelyAdapter.fetchJobs(ctx)).resolves.toEqual([]);
    expect(ctx.recordedErrors).toHaveLength(0);
  });
});
