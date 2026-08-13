import type { Db } from "./db.js";
import type {
  CuratedSourceKey,
  Difficulty,
  DiscoveredVia,
  RoleCategory,
  Source,
  Status,
} from "./enums.js";
import type { Company, CrawlRun, Job } from "./schemas.js";

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

export interface ListCompaniesFilter {
  discoveredVia?: DiscoveredVia;
  /** Page size. Default: 50 */
  limit?: number;
  /** Row offset. Default: 0 */
  offset?: number;
}

export interface ListCompaniesResult {
  rows: Company[];
  total: number;
}

/**
 * List companies newest first, optionally filtered by discovered_via, with the
 * total count of matching rows (for pagination).
 */
export async function listCompanies(
  db: Db,
  filter: ListCompaniesFilter = {},
): Promise<ListCompaniesResult> {
  const { discoveredVia, limit = 50, offset = 0 } = filter;

  const params: unknown[] = [];
  let where = "";
  if (discoveredVia !== undefined) {
    params.push(discoveredVia);
    where = `WHERE discovered_via = $${params.length}`;
  }

  const countResult = await db.query(
    `SELECT COUNT(*) AS total FROM companies ${where}`,
    params,
  );
  const total = parseInt(String(countResult.rows[0].total), 10);

  const rowsResult = await db.query(
    `SELECT * FROM companies ${where}
     ORDER BY created_at DESC NULLS LAST
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );

  return { rows: rowsResult.rows as Company[], total };
}

/** Per-source discovery rollup: companies count + last processed item. */
export interface SourceSummary {
  source_key: CuratedSourceKey;
  companies: number;
  items: number;
  last_processed_at: string | null;
}

/**
 * Summarize the curated sources: how many companies each source has discovered,
 * how many items (issues/pages) were processed, and when it last ran.
 */
export async function listSourceSummaries(db: Db): Promise<SourceSummary[]> {
  const result = await db.query(
    `SELECT si.source_key,
            COALESCE(c.companies, 0)::int AS companies,
            COUNT(si.id)::int AS items,
            MAX(si.processed_at) AS last_processed_at
     FROM source_items si
     LEFT JOIN (
       SELECT discovered_via, COUNT(*) AS companies
       FROM companies GROUP BY discovered_via
     ) c ON c.discovered_via = si.source_key
     GROUP BY si.source_key, c.companies
     ORDER BY si.source_key`,
  );
  return result.rows as SourceSummary[];
}

/** Headline numbers for the dashboard (one round trip per block). */
export interface DashboardStats {
  totalJobs: number;
  /** Jobs first seen in the last 7 days. */
  jobsLast7Days: number;
  statusCounts: Partial<Record<Status, number>>;
  totalCompanies: number;
  /** Companies added by the curated sources (non seed/web-search/manual). */
  curatedCompanies: number;
  latestRun: CrawlRun | null;
}

/** Aggregate the dashboard headline numbers. */
export async function getDashboardStats(db: Db): Promise<DashboardStats> {
  const statusRes = await db.query(
    `SELECT status, COUNT(*)::int AS n FROM jobs GROUP BY status`,
  );
  const statusCounts: Partial<Record<Status, number>> = {};
  let totalJobs = 0;
  for (const row of statusRes.rows as Array<{ status: Status; n: number }>) {
    statusCounts[row.status] = row.n;
    totalJobs += row.n;
  }

  const weekRes = await db.query(
    `SELECT COUNT(*)::int AS n FROM jobs WHERE first_seen_at > now() - interval '7 days'`,
  );
  const companiesRes = await db.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (
              WHERE discovered_via NOT IN ('seed', 'web-search', 'manual')
            )::int AS curated
     FROM companies`,
  );
  const runs = await listCrawlRuns(db, { limit: 1 });

  return {
    totalJobs,
    jobsLast7Days: (weekRes.rows[0] as { n: number }).n,
    statusCounts,
    totalCompanies: (companiesRes.rows[0] as { total: number }).total,
    curatedCompanies: (companiesRes.rows[0] as { curated: number }).curated,
    latestRun: runs[0] ?? null,
  };
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
