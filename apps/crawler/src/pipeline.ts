/**
 * The crawl pipeline (CONTRACT §Crawl pipeline; spec 07 §2).
 *
 * `runCrawl` executes ONE full cycle in the contract's fixed order:
 *   load criteria
 *   → sync seed companies (apps/crawler/seeds/companies.seed.json)
 *   → run each adapter isolated (one throwing does NOT kill the run)
 *   → normalize + upsert each RawJob
 *   → increment missing_streak for jobs a source no longer lists
 *   → classify unclassified jobs (score, then difficulty)
 *   → expire stale jobs (missing_streak >= 2, status new/notified)
 *   → notify (Discord)
 *   → record a crawl_runs row (per-source stats + notified_count + ok)
 *
 * SINGLE-FLIGHT: the cycle is wrapped in a Postgres advisory lock
 * (`pg_try_advisory_lock(CRAWL_LOCK_KEY)`) held on a dedicated session for the
 * whole run, so a launchd firing while a manual run is in progress is a no-op
 * instead of a double-post. Lock acquisition is INJECTABLE (`opts.acquireLock`)
 * so tests can force the "already held" branch: real cross-process locking is
 * exercised against real Postgres; PGlite is a single in-memory connection with
 * no second session, which is exactly why the "already running" branch is tested
 * via injection rather than a real concurrent lock.
 *
 * Every network- and clock-touching dependency is injectable so the whole cycle
 * runs in-process under vitest with zero network.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CrawlCtx,
  type CrawlRun,
  type CrawlRunInput,
  type Criteria,
  type Company,
  type Db,
  type Logger,
  type RawJob,
  type Source,
  type SourceAdapter,
  expireStaleJobs,
  getCriteria,
  incrementMissingStreakForMissing,
  parseSeedCompanies,
  recordCrawlRun,
  syncSeedCompanies,
  upsertJob,
} from "@jobscout/core";
import { createLlmClient, type LlmClient } from "./llm.js";
import { classifyPendingJobs, type ClassifierDeps } from "./classifier.js";
import { createHttpClient, type HttpClient } from "./http.js";
import { notifyNewMatches } from "./notifier.js";
import { ADAPTERS } from "./adapters/registry.js";

/**
 * The fixed advisory-lock key (spec 07 §Single-flight contract). Arbitrary
 * bigint, NEVER changed — both a launchd run and a manual run contend on it.
 */
export const CRAWL_LOCK_KEY = 8123407;

/** Absolute path to the seed-companies file the pipeline syncs each cycle. */
const SEED_COMPANIES_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../seeds/companies.seed.json",
);

/** Sources backed by official JSON board APIs (companies filtered by ats). */
const API_BOARD_SOURCES: ReadonlySet<Source> = new Set<Source>([
  "greenhouse",
  "lever",
  "ashby",
]);

/** Per-source tally folded into `crawl_runs.stats` (CrawlRunInput shape). */
type SourceStats = { fetched: number; new: number; updated: number; errors: string[] };

function emptyStats(): SourceStats {
  return { fetched: 0, new: 0, updated: 0, errors: [] };
}

/**
 * A lock handle held for the run. `release` drops the advisory lock and its
 * dedicated session. In the injected/PGlite path a no-op handle is returned.
 */
export interface CrawlLock {
  release: () => Promise<void>;
}

/**
 * Options for `runCrawl`. Everything the cycle touches that would otherwise hit
 * the network / a real clock is injectable, so tests run fully in-process.
 */
export interface RunCrawlOptions {
  /** How the run was triggered — recorded on the crawl_runs row. */
  trigger: CrawlRun["trigger"];
  /**
   * Adapter list to run. Defaults to the full registry (`ADAPTERS`); tests
   * inject a small stub list. Each adapter runs isolated.
   */
  adapters?: SourceAdapter[];
  /**
   * Acquire the single-flight lock. Returns a handle when acquired, or `null`
   * when another run already holds it (→ "already running", zero writes,
   * exit 0). Defaults to a real `pg_try_advisory_lock` on a dedicated session
   * built from `dbUrl`. Injectable so tests can force either branch.
   */
  acquireLock?: (db: Db) => Promise<CrawlLock | null>;
  /**
   * Connection string used to open the dedicated lock session in production.
   * Only read by the default `acquireLock`; tests inject `acquireLock` and omit
   * this.
   */
  dbUrl?: string;
  /** Politeness+retry fetch handed to adapters + classifier. Defaults to a real one. */
  fetch?: HttpClient;
  /** Provider-neutral LLM client for classification. Defaults to the configured provider. */
  llm?: LlmClient;
  /** Discord webhook URL for notifications. Defaults to `DISCORD_WEBHOOK_URL`. */
  webhookUrl?: string;
  /** fetch used for the Discord POST. Defaults to the injected/real `fetch`. */
  notifyFetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Logger. Defaults to a console logger. */
  logger?: Logger;
  /** Clock for started_at/finished_at. Defaults to real time. */
  now?: () => Date;
}

/** The summary `runCrawl` resolves with (also what the CLI prints). */
export interface CrawlSummary {
  /** Process exit code: 0 = ran (or was a lock no-op), 1 = cycle aborted. */
  exitCode: number;
  /** True when the lock was NOT acquired (another run holds it). */
  skipped: boolean;
  /** The recorded crawl_runs row, or null when skipped. */
  run: CrawlRun | null;
  /** Per-source + classifier/notifier stats (mirrors the recorded row). */
  stats: Record<string, SourceStats>;
  /** How many jobs were notified this cycle. */
  notifiedCount: number;
  /** Whether the pipeline ran to completion. */
  ok: boolean;
}

/** A console-backed Logger (the production default). */
function consoleLogger(): Logger {
  return {
    debug: (m, ...a) => console.debug(m, ...a),
    info: (m, ...a) => console.info(m, ...a),
    warn: (m, ...a) => console.warn(m, ...a),
    error: (m, ...a) => console.error(m, ...a),
  };
}

/**
 * Default lock: open a DEDICATED pg session (a session-mode connection, per
 * CONTRACT) and hold `pg_try_advisory_lock(CRAWL_LOCK_KEY)` for the whole run.
 * Because advisory locks are session-scoped, a crashed/killed run drops the
 * connection and the lock releases automatically — a crash cannot wedge us.
 *
 * NOTE: this path is exercised against real Postgres. PGlite has a single
 * in-memory connection and cannot model two contending sessions, so tests
 * inject `acquireLock` to drive both branches deterministically.
 */
export async function tryAcquireCrawlLock(dbUrl: string): Promise<CrawlLock | null> {
  const pg = (await import("pg")).default;
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const res = await client.query("select pg_try_advisory_lock($1) as locked", [
      CRAWL_LOCK_KEY,
    ]);
    const locked = res.rows[0]?.locked === true;
    if (!locked) {
      await client.end();
      return null;
    }
  } catch (err) {
    await client.end();
    throw err;
  }
  return {
    release: async () => {
      try {
        await client.query("select pg_advisory_unlock($1)", [CRAWL_LOCK_KEY]);
      } finally {
        await client.end();
      }
    },
  };
}

/**
 * Select the active companies handed to a given source. API boards get the
 * active companies whose `ats` matches the source; scraped sources (caljobs,
 * indeed, ziprecruiter) get an empty list (they search, they don't iterate a
 * company roster).
 */
function companiesForSource(source: Source, active: Company[]): Company[] {
  if (!API_BOARD_SOURCES.has(source)) return [];
  return active.filter((c) => c.ats === source);
}

/** Load and validate the seed-companies file (crawler owns fs; core stays fs-free). */
async function loadSeedCompanies(): Promise<ReturnType<typeof parseSeedCompanies>> {
  const text = await readFile(SEED_COMPANIES_PATH, "utf8");
  return parseSeedCompanies(JSON.parse(text) as unknown);
}

/** Read the active companies rows (used to build each adapter's CrawlCtx). */
async function loadActiveCompanies(db: Db): Promise<Company[]> {
  const res = await db.query(`select * from companies where active = true`);
  return res.rows as Company[];
}

/**
 * Run one adapter isolated: build its CrawlCtx (real fetch, criteria, the
 * companies for this source, a logger, a recordError sink), fetch its jobs,
 * upsert each, and tally per-source fetched/new/updated. A throwing adapter is
 * caught — its error recorded in this source's stats.errors — and the run
 * continues. Returns the source's stats and the external_ids it returned.
 */
async function runAdapter(
  db: Db,
  adapter: SourceAdapter,
  criteria: Criteria,
  active: Company[],
  fetchHelper: HttpClient,
  logger: Logger,
): Promise<{ stats: SourceStats; seenExternalIds: string[] }> {
  const stats = emptyStats();
  const ctx: CrawlCtx = {
    criteria,
    companies: companiesForSource(adapter.source, active),
    // CrawlCtx.fetch is FetchHelper (accepts string | URL); the HttpClient
    // accepts string, so normalize URL → string here.
    fetch: (input, init) =>
      fetchHelper(input instanceof URL ? input.toString() : input, init),
    logger,
    recordError: (message: string) => {
      stats.errors.push(message);
    },
  };

  let jobs: RawJob[];
  try {
    jobs = await adapter.fetchJobs(ctx);
  } catch (err) {
    // A throwing adapter must not kill the run (CONTRACT §Crawl pipeline).
    stats.errors.push(errString(err));
    return { stats, seenExternalIds: [] };
  }

  const seenExternalIds: string[] = [];
  for (const raw of jobs) {
    stats.fetched += 1;
    seenExternalIds.push(raw.externalId);
    try {
      const { isNew } = await upsertJob(db, raw);
      if (isNew) stats.new += 1;
      else stats.updated += 1;
    } catch (err) {
      stats.errors.push(`upsert ${raw.source}/${raw.externalId}: ${errString(err)}`);
    }
  }

  return { stats, seenExternalIds };
}

/**
 * Execute one full crawl cycle. See the file header for the fixed order and the
 * single-flight contract. Resolves with a `CrawlSummary`; never rejects for a
 * per-adapter or per-classifier failure (those are recorded and the run
 * continues). A failure of the cycle machinery itself still records a row with
 * `ok = false` and resolves with exitCode 1.
 */
export async function runCrawl(
  db: Db,
  opts: RunCrawlOptions,
): Promise<CrawlSummary> {
  const logger = opts.logger ?? consoleLogger();
  const now = opts.now ?? (() => new Date());
  const adapters = opts.adapters ?? ADAPTERS;
  const fetchHelper = opts.fetch ?? createHttpClient();
  const llm = opts.llm ?? createLlmClient();
  const webhookUrl = opts.webhookUrl ?? process.env.DISCORD_WEBHOOK_URL ?? "";
  const notifyFetch =
    opts.notifyFetch ??
    ((input: RequestInfo | URL, init?: RequestInit) =>
      fetchHelper(input as string, init));
  const acquireLock =
    opts.acquireLock ??
    ((_db: Db) => tryAcquireCrawlLock(opts.dbUrl ?? process.env.SUPABASE_DB_URL ?? ""));

  // --- Single-flight gate. If not acquired: no writes, no HTTP, exit 0. ---
  const lock = await acquireLock(db);
  if (!lock) {
    logger.info("crawl already running (advisory lock held); skipping");
    return {
      exitCode: 0,
      skipped: true,
      run: null,
      stats: {},
      notifiedCount: 0,
      ok: false,
    };
  }

  const startedAt = now().toISOString();
  const stats: Record<string, SourceStats> = {};
  let notifiedCount = 0;
  let ok = true;

  try {
    // 1. Load criteria.
    const criteria = await getCriteria(db);

    // 2. Sync the seed companies file into `companies`.
    const seed = await loadSeedCompanies();
    await syncSeedCompanies(db, seed);

    // Active companies snapshot handed to every adapter's CrawlCtx.
    const active = await loadActiveCompanies(db);

    // 3–5. Run each adapter isolated, upsert its jobs, and increment
    // missing_streak for jobs that source no longer lists.
    for (const adapter of adapters) {
      const { stats: sourceStats, seenExternalIds } = await runAdapter(
        db,
        adapter,
        criteria,
        active,
        fetchHelper,
        logger,
      );
      stats[adapter.source] = sourceStats;
      try {
        await incrementMissingStreakForMissing(
          db,
          adapter.source,
          seenExternalIds,
        );
      } catch (err) {
        sourceStats.errors.push(`missing_streak: ${errString(err)}`);
      }
    }

    // 6. Classify unclassified jobs (score, then difficulty). Classifier
    // failures are recorded under stats.classifier; the run continues.
    logger.info(`classifier LLM provider: ${llm.label}`);
    const classifierDeps: ClassifierDeps = {
      llm,
      fetchHtml: async (url: string) => {
        const res = await fetchHelper(url);
        return res.text();
      },
    };
    const classifierStats = emptyStats();
    try {
      const cs = await classifyPendingJobs(db, criteria, classifierDeps);
      classifierStats.errors.push(...cs.errors);
    } catch (err) {
      classifierStats.errors.push(errString(err));
    }
    stats.classifier = classifierStats;

    // 7. Expire stale jobs (missing_streak >= 2, status new/notified).
    await expireStaleJobs(db);

    // 8. Notify. Notifier failures are recorded under stats.notifier.
    const notifierStats = emptyStats();
    try {
      const result = await notifyNewMatches({
        data: db,
        criteria,
        webhookUrl,
        fetchImpl: notifyFetch,
      });
      notifiedCount = result.notifiedCount;
    } catch (err) {
      notifierStats.errors.push(errString(err));
    }
    stats.notifier = notifierStats;
  } catch (err) {
    // The cycle machinery itself aborted (e.g. missing criteria row). Record a
    // row with ok = false so there is always an audit trail, then exit 1.
    ok = false;
    logger.error(`crawl cycle aborted: ${errString(err)}`);
    const aborted = stats.pipeline ?? emptyStats();
    aborted.errors.push(errString(err));
    stats.pipeline = aborted;
  } finally {
    await lock.release();
  }

  // 9. Record the crawl_runs row (always — even on abort).
  const finishedAt = now().toISOString();
  const input: CrawlRunInput = {
    startedAt,
    finishedAt,
    trigger: opts.trigger,
    stats,
    notifiedCount,
    ok,
  };
  let run: CrawlRun | null = null;
  try {
    run = await recordCrawlRun(db, input);
  } catch (err) {
    logger.error(`failed to record crawl_runs row: ${errString(err)}`);
    ok = false;
  }

  return {
    exitCode: ok ? 0 : 1,
    skipped: false,
    run,
    stats,
    notifiedCount,
    ok,
  };
}

/** Normalize an unknown thrown value to a string. */
function errString(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
