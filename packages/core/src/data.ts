import type { Db } from "./db.js";
import type { Status } from "./enums.js";
import type { Company, CrawlRun, Criteria, Job, RawJob } from "./schemas.js";

/**
 * The data layer named by the specs. Wave 0 provides correct signatures only;
 * every body throws `not implemented: <name>`. Wave 1 fills these in against
 * the real schema, enforcing the status machine and dedup rules.
 */

/**
 * Normalize + upsert a raw job, conflicting on `(source, external_id)`:
 * updates `last_seen_at` + mutable fields and resets `missing_streak`.
 * Returns the resulting row.
 */
export function upsertJob(db: Db, raw: RawJob): Promise<Job> {
  throw new Error("not implemented: upsertJob");
}

/**
 * Move a job to a new status, enforcing the status machine
 * (throws InvalidTransitionError on an illegal transition).
 */
export function applyStatusTransition(
  db: Db,
  jobId: string,
  to: Status,
): Promise<Job> {
  throw new Error("not implemented: applyStatusTransition");
}

/** Mark a job as notified (`new -> notified`, set `notified_at = now()`). */
export function markNotified(db: Db, jobId: string): Promise<Job> {
  throw new Error("not implemented: markNotified");
}

/**
 * Increment `missing_streak` for jobs from a source that were not seen in the
 * current run (i.e. `last_seen_at` predates the run start). Returns the count
 * of rows touched.
 */
export function incrementMissingStreakForMissing(
  db: Db,
  source: string,
  runStartedAt: string,
): Promise<number> {
  throw new Error("not implemented: incrementMissingStreakForMissing");
}

/**
 * Expire jobs with `missing_streak >= 2` whose status is `new` or `notified`.
 * Returns the count of expired rows.
 */
export function expireStaleJobs(db: Db): Promise<number> {
  throw new Error("not implemented: expireStaleJobs");
}

/** Load the single `criteria` row's value. */
export function getCriteria(db: Db): Promise<Criteria> {
  throw new Error("not implemented: getCriteria");
}

/** Replace the single `criteria` row's value and bump `updated_at`. */
export function updateCriteria(db: Db, value: Criteria): Promise<Criteria> {
  throw new Error("not implemented: updateCriteria");
}

/** Insert a finished `crawl_runs` row and return it. */
export function recordCrawlRun(
  db: Db,
  run: Omit<CrawlRun, "id">,
): Promise<CrawlRun> {
  throw new Error("not implemented: recordCrawlRun");
}

/**
 * Sync the seed companies file into `companies` (upsert on `(ats, board_token)`).
 * Returns the resulting company rows.
 */
export function syncSeedCompanies(
  db: Db,
  companies: Array<Omit<Company, "id" | "created_at">>,
): Promise<Company[]> {
  throw new Error("not implemented: syncSeedCompanies");
}
