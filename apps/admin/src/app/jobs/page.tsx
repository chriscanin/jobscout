/**
 * /jobs — the board: filterable, sortable, paginated posting ledger
 * (spec 08 §3). Server Component: reads via listJobs from @jobscout/core,
 * public.
 */
import {
  Difficulty,
  JOB_SORTS,
  RoleCategory,
  Source,
  Status,
  listJobs,
  type JobSort,
} from "@jobscout/core";
import { getDb } from "../../lib/db";
import { transitionJobAction } from "../../lib/actions";
import { DifficultyChip, Score, StatusChip, shortDate } from "../../lib/chips";

const PAGE_SIZE = 50;

/** Status filter value that shows every posting, expired ones included. */
const ALL_STATUSES = "all";

/**
 * Score filter choices. The default, "Matches", hides the postings the keyword
 * prescreen scored 0 that nobody has acted on, which is most of the crawl
 * (sales, ops, Java...). Unscored and queued/applied postings stay visible.
 */
const SCORE_OPTIONS = [
  { value: "matches", label: "Matches" },
  { value: "50", label: "50+" },
  { value: "70", label: "70+" },
  { value: "all", label: "Everything" },
] as const;
const DEFAULT_SCORE = "matches";

/** Column header labels for the sortable columns. */
const SORT_LABELS: Record<JobSort, string> = {
  posted_at: "Posted date",
  match_score: "Match score",
  first_seen_at: "First seen",
};

/** Return `v` when it is one of `allowed`, else undefined (no filter). */
function pick<T extends string>(
  v: string | undefined,
  allowed: readonly T[],
): T | undefined {
  return allowed.includes(v as T) ? (v as T) : undefined;
}

interface SearchParams {
  status?: string;
  difficulty?: string;
  role_category?: string;
  source?: string;
  score?: string;
  sort?: string;
  dir?: string;
  page?: string;
}

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {

  const sp = await searchParams;
  // GET-form selects submit empty strings for the default option — validate
  // against the enum so "" (or junk) means "no filter" instead of a
  // match-nothing filter. The default hides expired postings; "all" shows them.
  const status = pick(sp.status, Status.options);
  const showAll = sp.status === ALL_STATUSES;
  const difficulty = pick(sp.difficulty, Difficulty.options);
  const roleCategory = pick(sp.role_category, RoleCategory.options);
  const source = pick(sp.source, Source.options);
  const score = SCORE_OPTIONS.find((o) => o.value === sp.score)?.value ?? DEFAULT_SCORE;
  const sort = pick(sp.sort, JOB_SORTS) ?? "posted_at";
  const dir = sp.dir === "asc" ? "asc" : "desc";
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const db = getDb();
  const { rows, total } = await listJobs(db, {
    status,
    difficulty,
    roleCategory,
    source,
    hideExpired: !showAll,
    hideNonMatches: score === "matches",
    minScore: score === "50" || score === "70" ? Number(score) : undefined,
    sort,
    dir,
    limit: PAGE_SIZE,
    offset,
  });

  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;

  function filterUrl(overrides: Record<string, string | undefined>) {
    const params = new URLSearchParams();
    const merged = {
      status: showAll ? ALL_STATUSES : status,
      difficulty,
      role_category: roleCategory,
      source,
      score,
      sort,
      dir,
      page: String(page),
      ...overrides,
    };
    for (const [k, v] of Object.entries(merged)) {
      if (v) params.set(k, v);
    }
    return `/jobs?${params.toString()}`;
  }

  /**
   * A column header that sorts the board by `col`. Clicking the column already
   * sorted on flips the direction; a new column starts newest / highest first.
   */
  function sortHeader(col: JobSort, label: string, className?: string) {
    const active = sort === col;
    const nextDir = active && dir === "desc" ? "asc" : "desc";
    return (
      <th
        className={className}
        aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : undefined}
      >
        <a
          href={filterUrl({ sort: col, dir: nextDir, page: "1" })}
          className={active ? "sort-link sort-active" : "sort-link"}
          title={`Sort by ${SORT_LABELS[col].toLowerCase()}`}
        >
          {label}
          {active && <span aria-hidden="true">{dir === "asc" ? " ↑" : " ↓"}</span>}
        </a>
      </th>
    );
  }

  return (
    <div>
      <section className="rise">
        <p className="kicker">The board</p>
        <h1>
          Postings <span style={{ color: "var(--ink-faint)" }}>({total})</span>
        </h1>
      </section>

      <section className="section rise">
        <form method="get" action="/jobs" className="filter-bar">
          <label>
            Status
            <select name="status" defaultValue={showAll ? ALL_STATUSES : (status ?? "")}>
              <option value="">Open (hide expired)</option>
              <option value={ALL_STATUSES}>All</option>
              {(["new", "notified", "queued", "applied", "dismissed", "expired"] as Status[]).map(
                (s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ),
              )}
            </select>
          </label>
          <label>
            Difficulty
            <select name="difficulty" defaultValue={difficulty ?? ""}>
              <option value="">All</option>
              {(["easy", "medium", "hard", "unknown"] as Difficulty[]).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <label>
            Category
            <select name="role_category" defaultValue={roleCategory ?? ""}>
              <option value="">All</option>
              {(["react-native", "react", "frontend", "fullstack", "other"] as RoleCategory[]).map(
                (rc) => (
                  <option key={rc} value={rc}>
                    {rc}
                  </option>
                ),
              )}
            </select>
          </label>
          <label>
            Source
            <select name="source" defaultValue={source ?? ""}>
              <option value="">All</option>
              {Source.options.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label>
            Score
            <select name="score" defaultValue={score}>
              {SCORE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Sort
            <select name="sort" defaultValue={sort}>
              {JOB_SORTS.map((col) => (
                <option key={col} value={col}>
                  {SORT_LABELS[col]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Order
            <select name="dir" defaultValue={dir}>
              <option value="desc">Newest / highest first</option>
              <option value="asc">Oldest / lowest first</option>
            </select>
          </label>
          <button type="submit" className="btn btn-primary">
            Filter
          </button>
        </form>

        <div className="ledger-wrap">
          <table className="ledger">
            <thead>
              <tr>
                <th>Posting</th>
                <th>Company</th>
                {sortHeader("match_score", "Score", "num")}
                <th>Difficulty</th>
                <th>Source</th>
                <th>Status</th>
                {sortHeader("posted_at", "Posted")}
                {sortHeader("first_seen_at", "Seen")}
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((job) => (
                <tr key={job.id}>
                  <td className="title-cell">
                    <a href={`/jobs/${job.id}`}>{job.title}</a>
                  </td>
                  <td>{job.company}</td>
                  <td className="num">
                    <Score value={job.match_score} />
                  </td>
                  <td>
                    <DifficultyChip value={job.difficulty} />
                  </td>
                  <td className="muted">{job.source}</td>
                  <td>
                    <StatusChip value={job.status} />
                  </td>
                  <td className="muted">{shortDate(job.posted_at)}</td>
                  <td className="muted">{shortDate(job.first_seen_at)}</td>
                  <td>
                    {(job.status === "new" || job.status === "notified") && (
                      <>
                        <form
                          action={async () => {
                            "use server";
                            await transitionJobAction(job.id, "queued");
                          }}
                          className="inline-form"
                        >
                          <button type="submit" className="btn btn-primary">
                            Queue
                          </button>
                        </form>
                        <form
                          action={async () => {
                            "use server";
                            await transitionJobAction(job.id, "dismissed");
                          }}
                          className="inline-form"
                        >
                          <button type="submit" className="btn btn-quiet">
                            Dismiss
                          </button>
                        </form>
                      </>
                    )}
                    {job.status === "queued" && (
                      <>
                        <form
                          action={async () => {
                            "use server";
                            await transitionJobAction(job.id, "applied");
                          }}
                          className="inline-form"
                        >
                          <button type="submit" className="btn btn-primary">
                            Applied
                          </button>
                        </form>
                        <form
                          action={async () => {
                            "use server";
                            await transitionJobAction(job.id, "dismissed");
                          }}
                          className="inline-form"
                        >
                          <button type="submit" className="btn btn-quiet">
                            Dismiss
                          </button>
                        </form>
                      </>
                    )}
                    {(job.status === "applied" || job.status === "dismissed") && (
                      <form
                        action={async () => {
                          "use server";
                          await transitionJobAction(job.id, "queued");
                        }}
                        className="inline-form"
                      >
                        <button type="submit" className="btn btn-quiet">
                          Undo
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={9}>
                    <p className="empty">No postings match these filters.</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="pager">
          {page > 1 && <a href={filterUrl({ page: String(page - 1) })}>← Prev</a>}
          <span>
            Page {page} of {totalPages}
          </span>
          {page < totalPages && (
            <a href={filterUrl({ page: String(page + 1) })}>Next →</a>
          )}
        </div>
      </section>
    </div>
  );
}
