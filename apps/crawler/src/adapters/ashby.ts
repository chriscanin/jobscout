import type { CrawlCtx, RawJob, SourceAdapter } from "@jobscout/core";

export const ashbyAdapter: SourceAdapter = {
  source: "ashby",
  fetchJobs(_ctx: CrawlCtx): Promise<RawJob[]> {
    throw new Error("not implemented: ashby adapter");
  },
};
