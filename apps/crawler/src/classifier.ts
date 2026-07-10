import type { Criteria, Db, Difficulty, Job, RoleCategory } from "@jobscout/core";

/**
 * Score a job against the current criteria, returning a match score (0–100)
 * and the reasons. Wave 2 implements.
 */
export async function scoreJob(
  _job: Job,
  _criteria: Criteria,
): Promise<{ score: number; reasons: string[]; category: RoleCategory | null }> {
  throw new Error("not implemented: scoreJob");
}

/**
 * Classify a job's application difficulty using the deterministic rubric
 * (CONTRACT §Difficulty rubric), falling back to Claude when needed.
 * Wave 2 implements.
 */
export async function classifyDifficulty(
  _job: Job,
  _ctx: { fetch: (input: string | URL, init?: RequestInit) => Promise<Response> },
): Promise<{ difficulty: Difficulty; reasons: string[] }> {
  throw new Error("not implemented: classifyDifficulty");
}

/**
 * Classify all unclassified jobs in the DB (match score, then difficulty).
 * Wave 2 implements.
 */
export async function classifyPendingJobs(
  _db: Db,
  _criteria: Criteria,
): Promise<number> {
  throw new Error("not implemented: classifyPendingJobs");
}
