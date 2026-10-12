/**
 * /jobs — the board: filterable, sortable, paginated posting ledger
 * (spec 08 §3). Server Component: reads via listJobs from @jobscout/core.
 * Public to browse; a signed-in person (lib/viewer) sees and moves their own
 * status on each posting.
 */
import {
  Difficulty,
  JOB_SORTS,
  RoleCategory,
  Source,
  listJobs,
  type JobSort,
} from "@jobscout/core";
import { getDb } from "../../lib/db";
import { getViewer } from "../../lib/viewer";
import { transitionJobAction } from "../../lib/actions";
import { DifficultyChip, Score, StatusChip, shortDate } from "../../lib/chips";
import { movesFor } from "../../lib/moves";

const PAGE_SIZE = 50;

/**
 * Status filter choices. The default ("") is Open: everything not expired,
 * minus what the viewer dismissed. The personal views need a signed-in person
 * and are not offered (or honoured) otherwise.
 */
const STATUS_VIEWS = [
  { value: "", label: "Open", personal: false },
  { value: "unreviewed", label: "Not reviewed by me", personal: true },
  { value: "queued", label: "My queue", personal: true },
  { value: "applied", label: "I applied", personal: true },
  { value: "dismissed", label: "I dismissed", personal: true },
  { value: "expired", label: "Expired", personal: false },
  { value: "all", label: "All", personal: false },
] as const;
type StatusView = (typeof STATUS_VIEWS)[number]["value"];

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
  const viewer = await getViewer();
  // GET-form selects submit empty strings for the default option — validate
  // against the known values so "" (or junk) means the default instead of a
  // match-nothing filter.
  const statusViews = STATUS_VIEWS.filter((v) => viewer || !v.personal);
  const view: StatusView = statusViews.find((v) => v.value === sp.status)?.value ?? "";
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
    viewerId: viewer?.id,
    status: view === "expired" ? "expired" : undefined,
    mine:
      view === "unreviewed" || view === "queued" || view === "applied" || view === "dismissed"
        ? view
        : undefined,
    hideExpired: view === "" || view === "unreviewed",
    hideMyDismissed: view === "",
    difficulty,
    roleCategory,
    source,
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
      status: view || undefined,
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
        {!viewer && (
          <p className="lede">
            Browsing only. To keep your own queue, open the invite link you were sent.
          </p>
        )}
      </section>

      <section className="section rise">
        <form method="get" action="/jobs" className="filter-bar">
          <label>
            Status
            <select name="status" defaultValue={view}>
              {statusViews.map((v) => (
                <option key={v.value} value={v.value}>
                  {v.label}
                </option>
              ))}
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
                {viewer && <th>Actions</th>}
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
                    {job.my_status ? (
                      <StatusChip value={job.my_status} />
                    ) : job.status === "expired" ? (
                      <StatusChip value="expired" />
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="muted">{shortDate(job.posted_at)}</td>
                  <td className="muted">{shortDate(job.first_seen_at)}</td>
                  {viewer && (
                    <td>
                      {movesFor(job.my_status).map((move) => (
                        <form
                          key={move.to}
                          action={async () => {
                            "use server";
                            await transitionJobAction(job.id, move.to);
                          }}
                          className="inline-form"
                        >
                          <button
                            type="submit"
                            className={move.primary ? "btn btn-primary" : "btn btn-quiet"}
                          >
                            {move.label}
                          </button>
                        </form>
                      ))}
                    </td>
                  )}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={viewer ? 9 : 8}>
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
