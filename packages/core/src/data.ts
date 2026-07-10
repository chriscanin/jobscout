import { dedupHash } from "./dedup.js";
import type { Db } from "./db.js";
import type { Source, Status } from "./enums.js";
import {
  Criteria,
  type CrawlRun,
  type Job,
  type RawJob,
  type SeedCompany,
} from "./schemas.js";
import { InvalidTransitionError, isAllowedTransition } from "./status.js";

/**
 * The data layer (spec 01 §2). Every function takes the `Db` abstraction first
 * so it runs on both pg (prod) and PGlite (tests). SQL uses the exact table /
 * column / enum names from CONTRACT §Database schema.
 */

/** Descriptions are truncated to this many chars before storage. */
const MAX_DESCRIPTION_CHARS = 20_000;

function truncateDescription(description: string | null): string | null {
  if (description == null) return null;
  return description.slice(0, MAX_DESCRIPTION_CHARS);
}

/** The status entry-timestamp column, when a status has one (else null). */
function timestampColumnFor(to: Status): string | null {
  switch (to) {
    case "notified":
      return "notified_at";
    case "applied":
      return "applied_at";
    case "dismissed":
      return "dismissed_at";
    default:
      return null;
  }
}

/**
 * Insert a brand-new job (status `new`, `first_seen_at = last_seen_at = now()`,
 * `dedup_hash` computed via `dedupHash`, `ats` from `atsHint ?? 'unknown'`), or
 * on conflict `(source, external_id)` update the mutable fields + reset
 * `missing_streak = 0`. Never touches `status`, `first_seen_at`, `notes`, or the
 * classification columns. Returns the row plus whether it was newly inserted.
 */
export async function upsertJob(
  db: Db,
  raw: RawJob,
): Promise<{ job: Job; isNew: boolean }> {
  const ats = raw.atsHint ?? "unknown";
  const location = raw.location ?? null;
  const hash = dedupHash(raw.company, raw.title, location);
  const description = truncateDescription(raw.description ?? null);
  const rawJson = raw.raw === undefined ? null : JSON.stringify(raw.raw);

  const result = await db.query(
    `insert into jobs (
       source, external_id, url, apply_url, title, company, location,
       salary_raw, description, posted_at, ats, dedup_hash, raw,
       first_seen_at, last_seen_at
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), now())
     on conflict (source, external_id) do update set
       url = excluded.url,
       apply_url = excluded.apply_url,
       title = excluded.title,
       company = excluded.company,
       location = excluded.location,
       salary_raw = excluded.salary_raw,
       description = excluded.description,
       posted_at = excluded.posted_at,
       ats = excluded.ats,
       dedup_hash = excluded.dedup_hash,
       raw = excluded.raw,
       last_seen_at = now(),
       missing_streak = 0
     returning *, (xmax = 0) as is_new`,
    [
      raw.source,
      raw.externalId,
      raw.url,
      raw.applyUrl ?? null,
      raw.title,
      raw.company,
      location,
      raw.salaryRaw ?? null,
      description,
      raw.postedAt ?? null,
      ats,
      hash,
      rawJson,
    ],
  );

  const row = result.rows[0];
  const isNew = row.is_new === true;
  delete row.is_new;
  return { job: row as Job, isNew };
}

/**
 * Move a job to `to`, enforcing ALLOWED_TRANSITIONS (throws
 * `InvalidTransitionError` on an illegal transition; the row is not modified).
 * Stamps the matching entry timestamp (notified_at/applied_at/dismissed_at) on
 * entry, and never clears it.
 */
export async function applyStatusTransition(
  db: Db,
  jobId: string,
  to: Status,
): Promise<Job> {
  const current = await db.query(`select status from jobs where id = $1`, [
    jobId,
  ]);
  if (current.rows.length === 0) {
    throw new Error(`job not found: ${jobId}`);
  }
  const from = current.rows[0].status as Status;
  if (!isAllowedTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }

  const tsColumn = timestampColumnFor(to);
  const setTs = tsColumn ? `, ${tsColumn} = coalesce(${tsColumn}, now())` : "";
  const result = await db.query(
    `update jobs set status = $2${setTs} where id = $1 returning *`,
    [jobId, to],
  );
  return result.rows[0] as Job;
}

/** Mark a job as notified (`new|notified -> notified`, stamp `notified_at`). */
export function markNotified(db: Db, jobId: string): Promise<Job> {
  return applyStatusTransition(db, jobId, "notified");
}

/**
 * `+1 missing_streak` for jobs of `source` whose `external_id` is NOT in
 * `seenExternalIds` and whose status is not already `expired`. Returns the
 * number of rows touched.
 */
export async function incrementMissingStreakForMissing(
  db: Db,
  source: Source,
  seenExternalIds: string[],
): Promise<number> {
  const result = await db.query(
    `update jobs
       set missing_streak = missing_streak + 1
     where source = $1
       and status <> 'expired'
       and not (external_id = any($2::text[]))
     returning id`,
    [source, seenExternalIds],
  );
  return (result.rows as unknown[]).length;
}

/**
 * Expire stale jobs: `status = 'expired'` where `missing_streak >= 2` AND status
 * is `new` or `notified`. Never touches queued/applied/dismissed. Returns count.
 */
export async function expireStaleJobs(db: Db): Promise<number> {
  const result = await db.query(
    `update jobs
       set status = 'expired'
     where missing_streak >= 2
       and status in ('new', 'notified')
     returning id`,
  );
  return (result.rows as unknown[]).length;
}

/** Read the single `criteria` row (id = 1), validate with zod, return it. */
export async function getCriteria(db: Db): Promise<Criteria> {
  const result = await db.query(`select value from criteria where id = 1`);
  if (result.rows.length === 0) {
    throw new Error("criteria row (id = 1) not found");
  }
  return Criteria.parse(result.rows[0].value);
}

/**
 * Validate `value` with zod FIRST (throws before writing on invalid), then
 * persist to the single `criteria` row and bump `updated_at`.
 */
export async function updateCriteria(
  db: Db,
  value: unknown,
): Promise<Criteria> {
  const parsed = Criteria.parse(value);
  await db.query(
    `update criteria set value = $1, updated_at = now() where id = 1`,
    [JSON.stringify(parsed)],
  );
  return parsed;
}

/** The shape `recordCrawlRun` accepts (spec 01 §2). */
export interface CrawlRunInput {
  startedAt: string;
  finishedAt: string;
  trigger: "launchd" | "manual" | "loop";
  stats: Record<
    string,
    { fetched: number; new: number; updated: number; errors: string[] }
  >;
  notifiedCount: number;
  ok: boolean;
}

/** Insert a finished `crawl_runs` row and return it. */
export async function recordCrawlRun(
  db: Db,
  run: CrawlRunInput,
): Promise<CrawlRun> {
  const result = await db.query(
    `insert into crawl_runs
       (started_at, finished_at, trigger, stats, notified_count, ok)
     values ($1, $2, $3, $4, $5, $6)
     returning *`,
    [
      run.startedAt,
      run.finishedAt,
      run.trigger,
      JSON.stringify(run.stats),
      run.notifiedCount,
      run.ok,
    ],
  );
  return result.rows[0] as CrawlRun;
}

/**
 * Upsert each seed company on `(ats, board_token)`, `discovered_via = 'seed'`.
 * On conflict updates `name` and `careers_url` only — never touches `active`
 * (the user may have deactivated a company in admin) or `last_crawled_at`.
 * Returns how many rows were inserted vs updated.
 */
export async function syncSeedCompanies(
  db: Db,
  companies: SeedCompany[],
): Promise<{ inserted: number; updated: number }> {
  let inserted = 0;
  let updated = 0;
  for (const c of companies) {
    const result = await db.query(
      `insert into companies (name, ats, board_token, careers_url, discovered_via, active)
       values ($1, $2, $3, $4, 'seed', true)
       on conflict (ats, board_token) do update set
         name = excluded.name,
         careers_url = excluded.careers_url
       returning (xmax = 0) as is_new`,
      [c.name, c.ats, c.boardToken ?? null, c.careersUrl ?? null],
    );
    if (result.rows[0].is_new === true) inserted += 1;
    else updated += 1;
  }
  return { inserted, updated };
}
