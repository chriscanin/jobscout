import type { CrawlCtx, RawJob, SourceAdapter } from "@jobscout/core";

export const greenhouseAdapter: SourceAdapter = {
  source: "greenhouse",
  fetchJobs(_ctx: CrawlCtx): Promise<RawJob[]> {
    throw new Error("not implemented: greenhouse adapter");
  },
};
