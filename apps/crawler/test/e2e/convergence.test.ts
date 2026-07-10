/**
 * End-to-end convergence suite (spec 09, scenarios 1–5) — the win condition.
 *
 * This is a REAL end to end. It stands up:
 *   - a REAL local HTTP fixture server (node:http) serving the captured board /
 *     job-detail / lever / apply-page fixtures at the real API paths, plus a
 *     fixture-backed Anthropic Messages endpoint and a Discord webhook sink;
 *   - the REAL pipeline (`runCrawl`) driving the REAL greenhouse + lever
 *     adapters, the REAL classifier (scoreMatch + rankDifficulty) and the REAL
 *     notifier, wired to the server via an injected routing `fetch` (the real
 *     HttpClient) so no code is bypassed;
 *   - an in-process PGlite database (migrations applied) as the one shared DB;
 *   - a no-op advisory lock (PGlite is single-connection).
 *
 * The five scenarios run in order against ONE server + ONE database and the
 * suite exits 0 only if all pass.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyStatusTransition,
  createPgliteTestDb,
  type Db,
} from "@jobscout/core";
import { runCrawl, type CrawlLock } from "../../src/pipeline.js";
import { runDoctor } from "../../src/cli.js";
import { greenhouseAdapter } from "../../src/adapters/greenhouse.js";
import { leverAdapter } from "../../src/adapters/lever.js";
import {
  startFixtureServer,
  RN_JOB_ID,
  LEVER_LLM_JOB_ID,
  LEVER_QUEUED_JOB_ID,
  type FixtureServer,
} from "./fixture-server.js";

/** Difficulty → Discord embed color (spec 09 §2, 06's palette, verbatim). */
const COLOR = {
  easy: 3066993, // 0x2ECC71
  medium: 15844367, // 0xF1C40F
  hard: 15158332, // 0xE74C3C
  unknown: 9807270, // 0x95A5A6
} as const;

let db: Db;
let closeDb: () => Promise<void>;
let server: FixtureServer;

/** A no-op single-flight lock (PGlite has one connection; spec 09 §1). */
const noopLock: CrawlLock = { release: async () => {} };

/** Run one full crawl cycle against the fixture server + PGlite. */
async function runOneCrawl(trigger: "manual" | "loop" = "manual") {
  return runCrawl(db, {
    trigger,
    adapters: [greenhouseAdapter, leverAdapter],
    acquireLock: async () => noopLock,
    fetch: server.makeRoutingFetch(),
    llm: server.makeFixtureLlm(),
    webhookUrl: `${server.baseUrl}/discord/webhook`,
    notifyFetch: (input, init) =>
      globalThis.fetch(input as string, init),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
}

/** Convenience: first scalar of a single-column query. */
async function scalar<T = unknown>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query(sql, params);
  const row = r.rows[0] as Record<string, unknown> | undefined;
  if (!row) return undefined as unknown as T;
  return Object.values(row)[0] as T;
}

beforeAll(async () => {
  ({ db, close: closeDb } = await createPgliteTestDb());
  server = await startFixtureServer();

  // Seed the two board companies the e2e drives (greenhouse + lever). The
  // pipeline also syncs the seed file, but we insert directly so the test owns
  // exactly which companies are active regardless of the on-disk seed file.
  await db.query(
    `insert into companies (name, ats, board_token, discovered_via, active)
     values ('Mattermost', 'greenhouse', 'mattermost', 'seed', true)
     on conflict (ats, board_token) do nothing`,
  );
  await db.query(
    `insert into companies (name, ats, board_token, discovered_via, active)
     values ('ExampleCo', 'lever', 'exampleco', 'seed', true)
     on conflict (ats, board_token) do nothing`,
  );
});

afterAll(async () => {
  await server.close();
  await closeDb();
});

describe("spec 09 — convergence (end-to-end win condition)", () => {
  // -----------------------------------------------------------------------
  // Scenario 1 — fresh DB, seeded companies, one crawl (happy path)
  // -----------------------------------------------------------------------
  it("S1: one crawl classifies a react-native job and records a green crawl_run", async () => {
    const summary = await runOneCrawl("manual");

    expect(summary.exitCode).toBe(0);
    expect(summary.ok).toBe(true);

    // >= 1 react-native job with a real match_score, a decided difficulty, and
    // at least one difficulty reason.
    const rnCount = await scalar<string>(
      `select count(*) from jobs
        where role_category = 'react-native'
          and match_score is not null
          and difficulty <> 'unknown'
          and coalesce(array_length(difficulty_reasons, 1), 0) >= 1`,
    );
    expect(Number(rnCount)).toBeGreaterThanOrEqual(1);

    // The newest crawl_runs row: ok, trigger=manual, notified>=1, per-source
    // stats for greenhouse + lever with numeric fetched/new/updated + empty
    // errors, and NO FIXTURE_MODE_ESCAPE anywhere.
    const run = summary.run;
    expect(run).not.toBeNull();
    expect(run!.ok).toBe(true);
    expect(run!.trigger).toBe("manual");
    expect(run!.notified_count).toBeGreaterThanOrEqual(1);

    const stats = summary.stats;
    for (const src of ["greenhouse", "lever"]) {
      expect(stats[src]).toBeDefined();
      expect(typeof stats[src].fetched).toBe("number");
      expect(typeof stats[src].new).toBe("number");
      expect(typeof stats[src].updated).toBe("number");
      expect(stats[src].errors).toEqual([]);
    }
    // Zero external traffic: no adapter recorded a fixture-escape error.
    const allErrors = Object.values(stats).flatMap((s) => s.errors);
    expect(allErrors.join("\n")).not.toContain("FIXTURE_MODE_ESCAPE");

    // The scoring batch ran (a body carrying the serialized criteria JSON) and
    // the lever LLM difficulty fallback ran (a body carrying the rubric marker).
    const llmBodies = server.llmPosts();
    // The scoring prompt embeds the serialized criteria JSON, which contains the
    // `notify_min_score` key; the difficulty fallback prompt carries the rubric
    // reference marker "Ulta Beauty".
    const scored = llmBodies.some((b) =>
      JSON.stringify(b).includes("notify_min_score"),
    );
    const difficulty = llmBodies.some((b) =>
      JSON.stringify(b).includes("Ulta Beauty"),
    );
    expect(scored).toBe(true);
    expect(difficulty).toBe(true);

    // The lever LLM job resolved to `medium` with reasons.
    const leverDiff = await db.query(
      `select difficulty, difficulty_reasons from jobs
        where source = 'lever' and external_id = $1`,
      [LEVER_LLM_JOB_ID],
    );
    expect(leverDiff.rows[0].difficulty).toBe("medium");
    expect((leverDiff.rows[0].difficulty_reasons as string[]).length).toBeGreaterThanOrEqual(1);
  });

  // -----------------------------------------------------------------------
  // Scenario 2 — Discord received the notification, correctly shaped
  // -----------------------------------------------------------------------
  it("S2: Discord got a well-shaped message and the RN embed color matches difficulty", async () => {
    const discordPosts = server.discordPosts();
    expect(discordPosts.length).toBeGreaterThanOrEqual(1);

    // Every recorded webhook body has 1..10 embeds.
    for (const body of discordPosts) {
      const embeds = (body as { embeds?: unknown[] }).embeds;
      expect(Array.isArray(embeds)).toBe(true);
      expect(embeds!.length).toBeGreaterThanOrEqual(1);
      expect(embeds!.length).toBeLessThanOrEqual(10);
    }

    // The RN reference embed (url contains external id 5238290008) carries the
    // color for the difficulty the pipeline assigned it. The captured RN
    // posting has 19 questions incl. custom fields → greenhouse rule => medium.
    const rnDifficulty = await scalar<string>(
      `select difficulty from jobs where source = 'greenhouse' and external_id = $1`,
      [RN_JOB_ID],
    );
    const rnEmbed = discordPosts
      .flatMap((b) => ((b as { embeds?: Array<{ url?: string; color?: number }> }).embeds ?? []))
      .find((e) => typeof e.url === "string" && e.url.includes(RN_JOB_ID));
    expect(rnEmbed).toBeDefined();
    expect(rnEmbed!.color).toBe(COLOR[rnDifficulty as keyof typeof COLOR]);

    // The RN job is now notified with a timestamp.
    const rn = await db.query(
      `select status, notified_at from jobs
        where source = 'greenhouse' and external_id = $1`,
      [RN_JOB_ID],
    );
    expect(rn.rows[0].status).toBe("notified");
    expect(rn.rows[0].notified_at).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // Scenario 3 — second identical run is idempotent
  // -----------------------------------------------------------------------
  it("S3: a second unchanged run posts zero new Discord messages and advances last_seen_at", async () => {
    const nWebhooks = server.discordPosts().length;
    const nJobs = Number(await scalar<string>(`select count(*) from jobs`));
    // PGlite returns timestamptz columns as JS Date objects — use them directly
    // (String()-ing a Date drops the milliseconds).
    const tMax = epochMs(await scalar<Date>(`select max(last_seen_at) from jobs`));

    // last_seen_at is stamped with SQL now() (wall-clock, ms resolution). Wait a
    // couple of ms so the second run's now() is strictly later than run 1's —
    // otherwise two back-to-back runs can land in the same millisecond.
    await new Promise((r) => setTimeout(r, 5));

    const summary = await runOneCrawl("manual");
    expect(summary.exitCode).toBe(0);

    // Zero new Discord messages.
    expect(server.discordPosts().length).toBe(nWebhooks);

    // No duplicate rows (upsert on (source, external_id)).
    const nJobs2 = Number(await scalar<string>(`select count(*) from jobs`));
    expect(nJobs2).toBe(nJobs);

    // Every still-listed job advanced: min(last_seen_at) strictly greater than T.
    const minSeen = epochMs(await scalar<Date>(`select min(last_seen_at) from jobs`));
    expect(minSeen).toBeGreaterThan(tMax);

    // Two green runs recorded.
    const okRuns = Number(
      await scalar<string>(`select count(*) from crawl_runs where ok = true`),
    );
    expect(okRuns).toBe(2);
  });

  // -----------------------------------------------------------------------
  // Scenario 4 — removed jobs expire; queued jobs survive
  // -----------------------------------------------------------------------
  it("S4: a dropped new/notified job expires but a dropped queued job survives", async () => {
    // Move the lever job to `queued` via the real data-layer transition
    // (new -> queued is legal), then drop BOTH it and the RN job from the board.
    await applyStatusTransition(db, await jobId("lever", LEVER_QUEUED_JOB_ID), "queued");
    server.dropGreenhouseJob(RN_JOB_ID);
    server.dropLeverJob(LEVER_QUEUED_JOB_ID);

    // Two more cycles: missing_streak reaches >= 2 and expiry runs.
    expect((await runOneCrawl("manual")).exitCode).toBe(0);
    expect((await runOneCrawl("manual")).exitCode).toBe(0);

    // The RN job (was `notified`) is now expired with missing_streak >= 2.
    const rn = await db.query(
      `select status, missing_streak from jobs
        where source = 'greenhouse' and external_id = $1`,
      [RN_JOB_ID],
    );
    expect(rn.rows[0].status).toBe("expired");
    expect(Number(rn.rows[0].missing_streak)).toBeGreaterThanOrEqual(2);

    // The queued lever job is missing too, but expiry only touches new|notified.
    const queued = await db.query(
      `select status, missing_streak from jobs
        where source = 'lever' and external_id = $1`,
      [LEVER_QUEUED_JOB_ID],
    );
    expect(queued.rows[0].status).toBe("queued");
    expect(Number(queued.rows[0].missing_streak)).toBeGreaterThanOrEqual(2);
  });

  // -----------------------------------------------------------------------
  // Scenario 5 — doctor passes; doctor fails loudly
  // -----------------------------------------------------------------------
  it("S5a: doctor passes against the fixture environment (exit 0, all four checks ok)", async () => {
    const env = fixtureDoctorEnv();
    const result = await runDoctor({
      env,
      makeDb: () => db,
      // The lmstudio llm check GETs `${LMSTUDIO_BASE_URL}/models` on the fixture.
      fetchImpl: (input, init) => globalThis.fetch(input as string, init),
    });
    expect(result.exitCode).toBe(0);
    const names = result.checks.map((c) => c.name).sort();
    expect(names).toEqual(["discord", "env", "llm", "supabase"]);
    for (const c of result.checks) expect(c.ok).toBe(true);
  });

  it("S5b: doctor fails loudly and names DISCORD_WEBHOOK_URL when it is unset", async () => {
    const env = fixtureDoctorEnv();
    delete env.DISCORD_WEBHOOK_URL;
    const result = await runDoctor({
      env,
      makeDb: () => db,
      fetchImpl: (input, init) => globalThis.fetch(input as string, init),
    });
    expect(result.exitCode).not.toBe(0);
    const joined = result.checks.map((c) => `${c.name}:${c.detail}`).join("\n");
    expect(joined).toContain("DISCORD_WEBHOOK_URL");
  });
});

/** Epoch millis from a value that PGlite may hand back as a Date or a string. */
function epochMs(value: Date | string | number): number {
  if (value instanceof Date) return value.getTime();
  return new Date(value).getTime();
}

/** Look up a job's uuid by (source, external_id). */
async function jobId(source: string, externalId: string): Promise<string> {
  const r = await db.query(
    `select id from jobs where source = $1 and external_id = $2`,
    [source, externalId],
  );
  return r.rows[0].id as string;
}

/** The env a green doctor run sees in the fixture environment (lmstudio provider). */
function fixtureDoctorEnv(): NodeJS.ProcessEnv {
  return {
    SUPABASE_DB_URL: "postgres://fixture/db",
    LLM_PROVIDER: "lmstudio",
    LMSTUDIO_BASE_URL: server.llmBaseUrl(),
    LMSTUDIO_MODEL: server.llmModel(),
    DISCORD_WEBHOOK_URL: `${server.baseUrl}/discord/webhook`,
  };
}
