/**
 * HTTP client with per-host politeness spacing and retry logic.
 *
 * CONTRACT §Politeness / scraping rules:
 *   - >= 2000ms spacing per domain
 *   - retry up to 3 times on 429 and 5xx with exponential backoff
 *   - honor Retry-After header when present
 *   - normal browser User-Agent by default
 *
 * Everything is injectable for tests (transport, sleep, now, options).
 */

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

export interface HttpClientOptions {
  /** Underlying fetch implementation — defaults to globalThis.fetch. */
  transport?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Sleep function (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Clock (injectable for tests). Returns current epoch ms. */
  now?: () => number;
  /** Minimum milliseconds between requests to the same host. Default 2000. */
  minSpacingMs?: number;
  /** Maximum retry attempts on 429/5xx. Default 3. */
  maxRetries?: number;
  /** User-Agent header value. */
  userAgent?: string;
}

export type HttpClient = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

/** Extract hostname from a URL string (ignoring port). */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Parse the Retry-After header value into a millisecond delay.
 * Supports both integer-seconds and HTTP-date formats.
 */
function parseRetryAfterMs(value: string, now: () => number): number {
  const seconds = parseInt(value, 10);
  if (!isNaN(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  // Try HTTP-date format
  const date = new Date(value);
  if (!isNaN(date.getTime())) {
    return Math.max(0, date.getTime() - now());
  }
  return 0;
}

/**
 * Build and return a fetch-shaped function that enforces per-host politeness
 * spacing, retries on 429 / 5xx, and injects a User-Agent header.
 */
export function createHttpClient(opts: HttpClientOptions = {}): HttpClient {
  const {
    transport = (url, init) => globalThis.fetch(url, init),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    minSpacingMs = 2000,
    maxRetries = 3,
    userAgent = DEFAULT_USER_AGENT,
  } = opts;

  // Track last-request timestamp per host (epoch ms).
  const lastRequestAt = new Map<string, number>();

  return async function httpFetch(
    url: string,
    init?: RequestInit,
  ): Promise<Response> {
    const host = hostOf(url);

    // --- Politeness spacing ---
    const last = lastRequestAt.get(host);
    if (last !== undefined) {
      const elapsed = now() - last;
      if (elapsed < minSpacingMs) {
        await sleep(minSpacingMs - elapsed);
      }
    }

    // Merge User-Agent into request headers.
    const headers = new Headers((init?.headers as HeadersInit | undefined) ?? {});
    if (!headers.has("User-Agent")) {
      headers.set("User-Agent", userAgent);
    }
    const mergedInit: RequestInit = { ...init, headers };

    // --- Retry loop ---
    let attempt = 0;
    let lastResponse: Response | undefined;

    while (attempt <= maxRetries) {
      lastRequestAt.set(host, now());
      const response = await transport(url, mergedInit);

      if (response.ok || (response.status < 400 && response.status >= 200)) {
        // Success — return immediately.
        return response;
      }

      const isRetryable = response.status === 429 || response.status >= 500;
      if (!isRetryable || attempt >= maxRetries) {
        // Non-retryable or exhausted — return the last response.
        return response;
      }

      lastResponse = response;

      // Determine backoff delay.
      let delayMs: number;
      const retryAfter = response.headers.get("Retry-After");
      if (retryAfter) {
        delayMs = parseRetryAfterMs(retryAfter, now);
      } else {
        // Exponential backoff: 1s, 2s, 4s …
        delayMs = Math.pow(2, attempt) * 1000;
      }

      await sleep(delayMs);
      attempt++;
    }

    // Should not reach here but satisfy the type checker.
    return lastResponse!;
  };
}
