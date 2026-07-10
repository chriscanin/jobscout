import type { CrawlCtx, RawJob, SourceAdapter } from "@jobscout/core";

export const caljobsAdapter: SourceAdapter = {
  source: "caljobs",
  fetchJobs(_ctx: CrawlCtx): Promise<RawJob[]> {
    throw new Error("not implemented: caljobs adapter");
  },
};
