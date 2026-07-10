import type { Source } from "./enums.js";
import type { Company, Criteria, RawJob } from "./schemas.js";

/**
 * A minimal logger passed to adapters. Kept structural so any concrete logger
 * (console, pino, etc.) satisfies it.
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * A politeness- and retry-aware fetch helper (CONTRACT §Politeness). Same
 * signature as the global `fetch`; the implementation enforces per-domain
 * spacing and retries.
 */
export type FetchHelper = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Context handed to each adapter's `fetchJobs` (CONTRACT §Source adapter
 * interface): the current matching criteria, the active companies for this
 * source, a polite fetch helper, a logger, and a recordError channel.
 *
 * `recordError(message)` is the single channel the pipeline aggregates into
 * `crawl_runs.stats[source].errors`. Adapters must call this (not logger.error)
 * for per-company failures so the pipeline can surface them.
 */
export interface CrawlCtx {
  criteria: Criteria;
  companies: Company[];
  fetch: FetchHelper;
  logger: Logger;
  recordError: (message: string) => void;
}

/**
 * A source adapter (CONTRACT §Source adapter interface). Each adapter is
 * isolated during a run — one failing must not kill the run.
 */
export interface SourceAdapter {
  source: Source;
  fetchJobs(ctx: CrawlCtx): Promise<RawJob[]>;
}
