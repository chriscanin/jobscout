import type { Db, Job } from "@jobscout/core";

/**
 * Post a job notification to the Discord webhook (CONTRACT §Crawl pipeline).
 * Wave 3 implements.
 */
export async function notifyJob(_job: Job): Promise<void> {
  throw new Error("not implemented: notifyJob");
}

/**
 * Notify all eligible new jobs (status=new, score >= notify_min_score, etc.).
 * Returns the count of jobs notified. Wave 3 implements.
 */
export async function notifyEligibleJobs(_db: Db): Promise<number> {
  throw new Error("not implemented: notifyEligibleJobs");
}
