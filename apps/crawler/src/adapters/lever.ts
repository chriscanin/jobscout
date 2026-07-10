import type { CrawlCtx, RawJob, SourceAdapter } from "@jobscout/core";

export const leverAdapter: SourceAdapter = {
  source: "lever",
  fetchJobs(_ctx: CrawlCtx): Promise<RawJob[]> {
    throw new Error("not implemented: lever adapter");
  },
};
