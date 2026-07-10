import type { CrawlCtx } from "@jobscout/core";
import type { Company } from "@jobscout/core";

/**
 * Web-search-based company discovery (CONTRACT §Crawl pipeline).
 * Wave 4 implements: uses Anthropic web search to find companies matching
 * criteria and returns candidates for syncing into `companies`.
 */
export async function discoverCompanies(
  _ctx: CrawlCtx,
): Promise<Array<Omit<Company, "id" | "created_at">>> {
  throw new Error("not implemented: discoverCompanies");
}
