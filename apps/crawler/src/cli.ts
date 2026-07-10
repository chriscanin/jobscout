/**
 * jobscout crawler CLI (spec 07 §2). Four commands:
 *
 *   crawl   — one full cycle (default trigger `manual`; launchd passes launchd)
 *   loop    — foreground standing loop: run a cycle, sleep, repeat (trigger loop)
 *   discover— web-search company discovery (separate from crawl, per spec 04)
 *   doctor  — machine readiness: env, supabase, discord (GET only), anthropic
 *
 * The commander `.action`s are thin wrappers: they build a real pg `Db`, call
 * the exported entry function (runCrawl / runLoop / runDoctor / runDiscoverCli),
 * print the result, and `process.exit` with the returned code. The entry
 * functions take injected dependencies so every scenario runs in-process under
 * vitest with zero network — the bins just wire the real ones.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { Command } from "commander";
import { createPgDb, getCriteria, type Db, type Logger } from "@jobscout/core";
import { createAnthropicClient, type AnthropicLike } from "./anthropic.js";
import { createHttpClient } from "./http.js";
import { runCrawl, type CrawlSummary } from "./pipeline.js";
import {
  createDbCompaniesRepo,
  runDiscovery,
  type SearchClient,
} from "./discovery.js";

/** The env vars a crawler machine must have (CONTRACT §Environment variables). */
export const REQUIRED_ENV_VARS = [
  "SUPABASE_DB_URL",
  "ANTHROPIC_API_KEY",
  "DISCORD_WEBHOOK_URL",
] as const;

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../supabase/migrations",
);

/** A console-backed Logger (the CLI default). */
function consoleLogger(): Logger {
  return {
    debug: (m, ...a) => console.debug(m, ...a),
    info: (m, ...a) => console.info(m, ...a),
    warn: (m, ...a) => console.warn(m, ...a),
    error: (m, ...a) => console.error(m, ...a),
  };
}

// ===========================================================================
// crawl
// ===========================================================================

/**
 * Build a pg Db from SUPABASE_DB_URL, run one crawl, print the summary, and
 * resolve with the exit code. The bin `process.exit`s with it.
 */
export async function runCrawlCli(
  trigger: "launchd" | "manual" | "loop" = "manual",
  logger: Logger = consoleLogger(),
): Promise<CrawlSummary> {
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    logger.error("SUPABASE_DB_URL is not set");
    return {
      exitCode: 1,
      skipped: false,
      run: null,
      stats: {},
      notifiedCount: 0,
      ok: false,
    };
  }
  const db = createPgDb(dbUrl);
  const summary = await runCrawl(db, { trigger, dbUrl, logger });
  logger.info(
    `crawl ${summary.skipped ? "skipped (already running)" : summary.ok ? "ok" : "aborted"}` +
      ` — notified ${summary.notifiedCount}` +
      `; stats ${JSON.stringify(summary.stats)}`,
  );
  return summary;
}

// ===========================================================================
// loop
// ===========================================================================

/** Injectable dependencies for the standing loop (so tests use fake timers). */
export interface RunLoopDeps {
  /** Run one cycle; resolves when it finishes. */
  runOnce: () => Promise<unknown>;
  /** Milliseconds to sleep between cycles. */
  intervalMs: number;
  /** Sleep function (injectable — real setTimeout in production). */
  sleep?: (ms: number) => Promise<void>;
  /** Loop guard, checked before each cycle. Defaults to forever (`() => true`). */
  shouldContinue?: () => boolean;
}

/**
 * Foreground standing loop (spec 07 §2, S8): run a cycle, sleep `intervalMs`,
 * repeat while `shouldContinue()` is true. The sleep starts AFTER the cycle
 * finishes (no drift, no overlap — the next cycle cannot start until the sleep
 * resolves). `shouldContinue` is checked exactly once per iteration, at the top,
 * so injecting a guard that returns true N times runs exactly N cycles. `sleep`
 * and `shouldContinue` are injectable so a test can run exactly two cycles under
 * fake timers.
 */
export async function runLoop(deps: RunLoopDeps): Promise<void> {
  const {
    runOnce,
    intervalMs,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    shouldContinue = () => true,
  } = deps;

  // First cycle fires immediately; each subsequent cycle waits out one sleep.
  let first = true;
  while (shouldContinue()) {
    if (!first) await sleep(intervalMs);
    first = false;
    await runOnce();
  }
}

/** The `loop` command action: run crawl cycles (trigger `loop`) forever. */
export async function runLoopCli(
  intervalMinutes: number,
  logger: Logger = consoleLogger(),
): Promise<void> {
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    logger.error("SUPABASE_DB_URL is not set");
    process.exitCode = 1;
    return;
  }
  const db = createPgDb(dbUrl);
  const intervalMs = intervalMinutes * 60_000;
  logger.info(`loop: running every ${intervalMinutes} minute(s); Ctrl-C to stop`);
  await runLoop({
    intervalMs,
    runOnce: async () => {
      const summary = await runCrawl(db, { trigger: "loop", dbUrl, logger });
      logger.info(
        `loop cycle ${summary.skipped ? "skipped" : summary.ok ? "ok" : "aborted"}` +
          ` — notified ${summary.notifiedCount}`,
      );
    },
  });
}

// ===========================================================================
// discover
// ===========================================================================

/**
 * Build a Db, run web-search discovery, print how many companies were added,
 * and resolve with the exit code. Discovery deps are injectable for tests.
 */
export async function runDiscoverCli(
  logger: Logger = consoleLogger(),
  deps?: {
    db?: Db;
    searchClient?: SearchClient;
    fetchFn?: typeof fetch;
  },
): Promise<number> {
  const dbUrl = process.env.SUPABASE_DB_URL;
  const db = deps?.db ?? (dbUrl ? createPgDb(dbUrl) : undefined);
  if (!db) {
    logger.error("SUPABASE_DB_URL is not set");
    return 1;
  }
  const criteria = await getCriteria(db);
  const searchClient = deps?.searchClient ?? createWebSearchClient(createAnthropicClient());
  const fetchFn =
    deps?.fetchFn ??
    ((input: RequestInfo | URL, init?: RequestInit) =>
      createHttpClient()(input as string, init));
  const stats = await runDiscovery({
    searchClient,
    fetchFn: fetchFn as typeof fetch,
    companies: createDbCompaniesRepo(db),
    criteria,
    logger,
  });
  logger.info(
    `discover: added ${stats.inserted} compan${stats.inserted === 1 ? "y" : "ies"}` +
      ` (${stats.searches} searches, ${stats.skippedKnown} known, ${stats.invalid} invalid,` +
      ` ${stats.errors.length} errors)`,
  );
  return stats.errors.length > 0 ? 1 : 0;
}

/**
 * Production `SearchClient` backed by the Anthropic web_search tool. Runs one
 * `messages` request per query and collects the `url`/`title` pairs from the
 * `web_search_tool_result` content blocks. Tests inject a stub instead of this.
 */
export function createWebSearchClient(anthropic: AnthropicLike): SearchClient {
  return {
    async search(query: string) {
      const res = await anthropic.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 1024,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
        messages: [{ role: "user", content: query }],
      });
      const results: { url: string; title: string }[] = [];
      for (const block of res.content) {
        if (block.type !== "web_search_tool_result") continue;
        const content = (block as { content?: unknown }).content;
        if (!Array.isArray(content)) continue;
        for (const item of content) {
          const url = (item as { url?: unknown }).url;
          const title = (item as { title?: unknown }).title;
          if (typeof url === "string") {
            results.push({ url, title: typeof title === "string" ? title : url });
          }
        }
      }
      return results;
    },
  };
}

// ===========================================================================
// doctor
// ===========================================================================

/** One doctor check result. */
export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** The doctor result: the exit code and every check (nothing short-circuits). */
export interface DoctorResult {
  exitCode: number;
  checks: DoctorCheck[];
}

/**
 * env check (spec 07 §2, check 1): every required env var is set and non-empty.
 * Pure over `env` so it is unit-testable in isolation. Names EACH missing var.
 */
export function checkEnv(env: NodeJS.ProcessEnv): DoctorCheck {
  const missing = REQUIRED_ENV_VARS.filter((k) => {
    const v = env[k];
    return v === undefined || v.trim() === "";
  });
  return {
    name: "env",
    ok: missing.length === 0,
    detail:
      missing.length === 0
        ? "all required env vars set"
        : `missing/empty: ${missing.join(", ")}`,
  };
}

/** Injectable dependencies for the network/db doctor checks (offline in tests). */
export interface DoctorDeps {
  env?: NodeJS.ProcessEnv;
  /** Opens a Db from a connection string. Defaults to `createPgDb`. */
  makeDb?: (url: string) => Db;
  /** fetch used for the Discord GET + Anthropic ping. Defaults to global fetch. */
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Anthropic client factory. Defaults to `createAnthropicClient`. */
  makeAnthropic?: (apiKey: string) => AnthropicLike;
  /** Migration files on disk (for the "migrations current" check). */
  listMigrations?: () => Promise<string[]>;
}

/** supabase check (check 2): DB reachable AND the four tables + criteria row exist. */
async function checkSupabase(deps: DoctorDeps): Promise<DoctorCheck> {
  const env = deps.env ?? process.env;
  const url = env.SUPABASE_DB_URL;
  if (!url || url.trim() === "") {
    return { name: "supabase", ok: false, detail: "SUPABASE_DB_URL not set" };
  }
  const makeDb = deps.makeDb ?? createPgDb;
  try {
    const db = makeDb(url);
    // Each of the four tables must exist and be queryable.
    for (const table of ["jobs", "companies", "crawl_runs", "criteria"]) {
      await db.query(`select 1 from ${table} limit 1`);
    }
    // The single criteria row (id = 1) must be present (migrations seeded it).
    const c = await db.query(`select 1 from criteria where id = 1`);
    if (c.rows.length === 0) {
      return {
        name: "supabase",
        ok: false,
        detail: "criteria row (id = 1) missing — migrations not current",
      };
    }
    return { name: "supabase", ok: true, detail: "reachable; 4 tables + criteria row present" };
  } catch (err) {
    return { name: "supabase", ok: false, detail: `query failed: ${errString(err)}` };
  }
}

/**
 * discord check (check 3): GET the webhook URL; expect 200 with JSON containing
 * `id` and `token` (Discord returns webhook metadata on GET). POSTS NOTHING.
 */
async function checkDiscord(deps: DoctorDeps): Promise<DoctorCheck> {
  const env = deps.env ?? process.env;
  const url = env.DISCORD_WEBHOOK_URL;
  if (!url || url.trim() === "") {
    return { name: "discord", ok: false, detail: "DISCORD_WEBHOOK_URL not set" };
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(url, { method: "GET" });
    if (res.status !== 200) {
      return { name: "discord", ok: false, detail: `GET returned HTTP ${res.status}` };
    }
    const body = (await res.json()) as { id?: unknown; token?: unknown };
    if (typeof body.id === "string" && typeof body.token === "string") {
      return { name: "discord", ok: true, detail: `webhook ${body.id} valid` };
    }
    return { name: "discord", ok: false, detail: "GET body missing id/token" };
  } catch (err) {
    return { name: "discord", ok: false, detail: `GET failed: ${errString(err)}` };
  }
}

/** anthropic check (check 4): cheapest call — model claude-haiku-4-5, max_tokens 1. */
async function checkAnthropic(deps: DoctorDeps): Promise<DoctorCheck> {
  const env = deps.env ?? process.env;
  const key = env.ANTHROPIC_API_KEY;
  if (!key || key.trim() === "") {
    return { name: "anthropic", ok: false, detail: "ANTHROPIC_API_KEY not set" };
  }
  const makeAnthropic = deps.makeAnthropic ?? createAnthropicClient;
  try {
    const client = makeAnthropic(key);
    const res = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    });
    if (res && typeof res.id === "string") {
      return { name: "anthropic", ok: true, detail: "1-token call succeeded" };
    }
    return { name: "anthropic", ok: false, detail: "malformed messages response" };
  } catch (err) {
    return { name: "anthropic", ok: false, detail: `call failed: ${errString(err)}` };
  }
}

/**
 * Run all four doctor checks (spec 07 §2, S5/S6). Every check ALWAYS runs — a
 * failure never short-circuits the rest. Exit 1 if any check fails, naming each
 * failing check; else exit 0. Network/db checks are injectable so tests run
 * offline.
 */
export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorResult> {
  const env = deps.env ?? process.env;
  const checks: DoctorCheck[] = [
    checkEnv(env),
    await checkSupabase(deps),
    await checkDiscord(deps),
    await checkAnthropic(deps),
  ];
  const failing = checks.filter((c) => !c.ok);
  return { exitCode: failing.length === 0 ? 0 : 1, checks };
}

/** Print each doctor check and return the exit code. */
export function printDoctor(result: DoctorResult, logger: Logger = consoleLogger()): number {
  for (const c of result.checks) {
    logger.info(`[${c.ok ? "ok" : "FAIL"}] ${c.name}: ${c.detail}`);
  }
  const failing = result.checks.filter((c) => !c.ok).map((c) => c.name);
  if (failing.length > 0) {
    logger.error(`doctor: FAILED checks: ${failing.join(", ")}`);
  } else {
    logger.info("doctor: all checks green");
  }
  return result.exitCode;
}

/** Default migrations lister (used by the supabase check's migrations note). */
export async function listMigrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((f) => f.endsWith(".sql")).sort();
}

// ===========================================================================
// commander wiring
// ===========================================================================

/** Build the commander program. Exported so a test could parse args if needed. */
export function buildProgram(): Command {
  const program = new Command();
  program.name("jobscout").description("jobscout crawler CLI").version("0.0.0");

  program
    .command("crawl")
    .description("Run a single crawl across all active adapters")
    .option("--trigger <trigger>", "launchd | manual | loop", "manual")
    .action(async (opts: { trigger: string }) => {
      const trigger =
        opts.trigger === "launchd" || opts.trigger === "loop" ? opts.trigger : "manual";
      const summary = await runCrawlCli(trigger);
      process.exit(summary.exitCode);
    });

  program
    .command("loop")
    .description("Run crawl on a recurring interval (foreground)")
    .option("--interval <minutes>", "Interval in minutes between crawls", "60")
    .action(async (opts: { interval: string }) => {
      const minutes = Number.parseInt(opts.interval, 10);
      await runLoopCli(Number.isFinite(minutes) && minutes > 0 ? minutes : 60);
    });

  program
    .command("discover")
    .description("Run web-search-based company discovery")
    .action(async () => {
      const code = await runDiscoverCli();
      process.exit(code);
    });

  program
    .command("doctor")
    .description("Check environment and connectivity, report status")
    .action(async () => {
      const result = await runDoctor();
      const code = printDoctor(result);
      process.exit(code);
    });

  return program;
}

/** Normalize an unknown thrown value to a string. */
function errString(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// Parse argv only when run as the CLI entry (not when imported by tests).
const isMain = (() => {
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMain) {
  buildProgram().parse(process.argv);
}
