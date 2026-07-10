import type { Db } from "@jobscout/core";
import type { CrawlRun } from "@jobscout/core";

/**
 * Options for a single crawl run.
 */
export interface RunOptions {
  trigger: CrawlRun["trigger"];
  db: Db;
}

/**
 * Execute one full crawl pipeline (CONTRACT §Crawl pipeline):
 * load criteria → sync seed companies → run adapters → normalize + upsert →
 * increment missing_streak → classify → expire → notify → record crawl_runs.
 * Single-flight via pg_try_advisory_lock. Wave 3 implements.
 */
export async function runCrawlPipeline(
  _opts: RunOptions,
): Promise<CrawlRun> {
  throw new Error("not implemented: runCrawlPipeline");
}
