import type { CrawlCtx, RawJob, SourceAdapter } from "@jobscout/core";

export const indeedAdapter: SourceAdapter = {
  source: "indeed",
  fetchJobs(_ctx: CrawlCtx): Promise<RawJob[]> {
    throw new Error("not implemented: indeed adapter");
  },
};
