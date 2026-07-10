import type { Db } from "./db.js";
import type { Difficulty, RoleCategory, Source, Status } from "./enums.js";
import type { CrawlRun, Job } from "./schemas.js";

/**
 * Read-side queries for the admin app (spec 08 §1).
 * All functions take the `Db` abstraction first so they run on both pg (prod)
 * and PGlite (tests). Parameterized SQL only — no string interpolation of
 * user-supplied values.
 */

export interface ListJobsFilter {
  status?: Status;
  difficulty?: Difficulty;
  roleCategory?: RoleCategory;
  source?: Source;
  /** Column to sort by (descending). Default: "first_seen_at" */
  sort?: "match_score" | "first_seen_at";
  /** Sort direction. Default: "desc" */
  dir?: "asc" | "desc";
  /** Page size. Default: 50 */
  limit?: number;
  /** Row offset. Default: 0 */
  offset?: number;
}

export interface ListJobsResult {
  rows: Job[];
  total: number;
}

/**
 * List jobs with optional AND-combined filters, sort, and pagination.
 * Returns the rows for the requested page plus the total count of matching rows
 * (so the caller can compute total pages).
 */
export async function listJobs(
  db: Db,
  filter: ListJobsFilter = {},
): Promise<ListJobsResult> {
  const {
    status,
    difficulty,
    roleCategory,
    source,
    sort = "first_seen_at",
    dir = "desc",
    limit = 50,
    offset = 0,
  } = filter;

  // Build WHERE clauses dynamically using numbered params
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (status !== undefined) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  if (difficulty !== undefined) {
    params.push(difficulty);
    conditions.push(`difficulty = $${params.length}`);
  }
  if (roleCategory !== undefined) {
    params.push(roleCategory);
    conditions.push(`role_category = $${params.length}`);
  }
  if (source !== undefined) {
    params.push(source);
    conditions.push(`source = $${params.length}`);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // sort column is a fixed enum — safe to interpolate
  const sortCol = sort === "match_score" ? "match_score" : "first_seen_at";
  const sortDir = dir === "asc" ? "ASC" : "DESC";

  // Count query (reuse same params)
  const countResult = await db.query(
    `SELECT COUNT(*) AS total FROM jobs ${where}`,
    params,
  );
  const total = parseInt(String(countResult.rows[0].total), 10);

  // Rows query — append limit and offset params
  const limitParam = params.length + 1;
  const offsetParam = params.length + 2;
  const rowsResult = await db.query(
    `SELECT * FROM jobs ${where}
     ORDER BY ${sortCol} ${sortDir} NULLS LAST
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    [...params, limit, offset],
  );

  return { rows: rowsResult.rows as Job[], total };
}

/**
 * Fetch a single job row by its UUID. Returns null if not found.
 */
export async function getJob(db: Db, id: string): Promise<Job | null> {
  const result = await db.query(`SELECT * FROM jobs WHERE id = $1`, [id]);
  if (result.rows.length === 0) return null;
  return result.rows[0] as Job;
}

/**
 * List crawl_runs ordered newest first, limited to `limit` rows (default 50).
 */
export async function listCrawlRuns(
  db: Db,
  options: { limit?: number } = {},
): Promise<CrawlRun[]> {
  const limit = options.limit ?? 50;
  const result = await db.query(
    `SELECT * FROM crawl_runs ORDER BY started_at DESC NULLS LAST LIMIT $1`,
    [limit],
  );
  return result.rows as CrawlRun[];
}
