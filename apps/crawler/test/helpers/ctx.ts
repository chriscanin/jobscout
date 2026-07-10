/**
 * Test helper: build a CrawlCtx for adapter unit tests.
 *
 * Usage:
 *   const ctx = buildTestCtx({
 *     fixtures: { "https://api.example.com/jobs": new Response(JSON.stringify(payload)) },
 *     companies: [{ ...company }],
 *   });
 *   const jobs = await adapter.fetchJobs(ctx);
 *   expect(ctx.logger.errors).toHaveLength(0);
 */

import type { CrawlCtx, Logger } from "@jobscout/core";
import { DEFAULT_CRITERIA } from "@jobscout/core";
import type { Company } from "@jobscout/core";

/** A capturing logger that records messages for test assertions. */
export interface CapturingLogger extends Logger {
  /** All messages logged at "info" level. */
  infos: string[];
  /** All messages logged at "warn" level. */
  warns: string[];
  /** All messages logged at "error" level. */
  errors: string[];
  /** All messages logged at "debug" level. */
  debugs: string[];
}

function makeCapturingLogger(): CapturingLogger {
  const infos: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  const debugs: string[] = [];
  return {
    infos,
    warns,
    errors,
    debugs,
    debug(msg: string) { debugs.push(msg); },
    info(msg: string) { infos.push(msg); },
    warn(msg: string) { warns.push(msg); },
    error(msg: string) { errors.push(msg); },
  };
}

export interface BuildTestCtxOptions {
  /**
   * URL → Response map for the fake fetch.
   * If a URL is not found, the fetch returns a 404 response.
   */
  fixtures?: Map<string, Response> | Record<string, Response>;
  /** Companies to put in ctx.companies. Defaults to []. */
  companies?: Company[];
  /** Override the criteria. Defaults to DEFAULT_CRITERIA. */
  criteria?: CrawlCtx["criteria"];
  /** Override the logger. Defaults to a new CapturingLogger. */
  logger?: CapturingLogger;
}

export interface TestCtx extends CrawlCtx {
  /** The capturing logger so tests can assert on logged messages. */
  logger: CapturingLogger;
  /** Number of fetch calls made (for asserting call counts). */
  fetchCallCount: () => number;
  /** All messages passed to ctx.recordError — for test assertions. */
  recordedErrors: string[];
}

/**
 * Build a CrawlCtx suitable for adapter unit tests. The fetch helper is backed
 * by a URL→Response fixture map; missing URLs return HTTP 404.
 */
export function buildTestCtx(opts: BuildTestCtxOptions = {}): TestCtx {
  const {
    fixtures: fixturesInput,
    companies = [],
    criteria = DEFAULT_CRITERIA,
    logger: loggerOverride,
  } = opts;

  // Normalise fixtures to a Map<string, Response>.
  const fixtureMap: Map<string, Response> =
    fixturesInput instanceof Map
      ? fixturesInput
      : new Map(
          Object.entries(fixturesInput ?? {}).map(([k, v]) => [k, v]),
        );

  const logger = loggerOverride ?? makeCapturingLogger();

  let callCount = 0;
  const recordedErrors: string[] = [];

  const fakeFetch = async (
    url: string | URL,
    _init?: RequestInit,
  ): Promise<Response> => {
    callCount++;
    const urlStr = url instanceof URL ? url.toString() : url;
    const response = fixtureMap.get(urlStr);
    if (response) {
      // Clone so the body can be consumed multiple times in tests.
      return response.clone();
    }
    return new Response(`Not found: ${urlStr}`, { status: 404 });
  };

  return {
    criteria,
    companies,
    fetch: fakeFetch,
    logger,
    recordError: (message: string) => { recordedErrors.push(message); },
    fetchCallCount: () => callCount,
    recordedErrors,
  };
}
