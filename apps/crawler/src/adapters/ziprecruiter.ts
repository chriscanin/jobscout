import type { CrawlCtx, RawJob, SourceAdapter } from "@jobscout/core";

export const ziprecruiterAdapter: SourceAdapter = {
  source: "ziprecruiter",
  fetchJobs(_ctx: CrawlCtx): Promise<RawJob[]> {
    throw new Error("not implemented: ziprecruiter adapter");
  },
};
