/**
 * /jobs — the board: filterable, sortable, paginated posting ledger
 * (spec 08 §3). Server Component: reads via listJobs from @jobscout/core,
 * behind requireAllowedUser.
 */
import { Difficulty, RoleCategory, Source, Status, listJobs } from "@jobscout/core";
import { getDb } from "../../lib/db";
import { requireAllowedUser } from "../../lib/auth";
import { transitionJobAction } from "../../lib/actions";
import { DifficultyChip, Score, StatusChip, shortDate } from "../../lib/chips";

const PAGE_SIZE = 50;

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
  sort?: string;
  page?: string;
}

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  // Redirects (null session) or 403s (non-allowlisted) before any DB access.
  await requireAllowedUser();

  const sp = await searchParams;
  // GET-form selects submit empty strings for "All" — validate against the
  // enum so "" (or junk) means "no filter" instead of a match-nothing filter.
  const status = pick(sp.status, Status.options);
  const difficulty = pick(sp.difficulty, Difficulty.options);
  const roleCategory = pick(sp.role_category, RoleCategory.options);
  const source = pick(sp.source, Source.options);
  const sort =
    sp.sort === "match_score" || sp.sort === "first_seen_at"
      ? (sp.sort as "match_score" | "first_seen_at")
      : "first_seen_at";
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const db = getDb();
  const { rows, total } = await listJobs(db, {
    status,
    difficulty,
    roleCategory,
    source,
    sort,
    dir: "desc",
    limit: PAGE_SIZE,
    offset,
  });

  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;

  function filterUrl(overrides: Record<string, string | undefined>) {
    const params = new URLSearchParams();
    const merged = {
      status,
      difficulty,
      role_category: roleCategory,
      source,
      sort,
      page: String(page),
      ...overrides,
    };
    for (const [k, v] of Object.entries(merged)) {
      if (v) params.set(k, v);
    }
    return `/jobs?${params.toString()}`;
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
            <select name="status" defaultValue={status ?? ""}>
              <option value="">All</option>
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
            Sort
            <select name="sort" defaultValue={sort}>
              <option value="first_seen_at">First seen</option>
              <option value="match_score">Match score</option>
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
                <th className="num">Score</th>
                <th>Difficulty</th>
                <th>Source</th>
                <th>Status</th>
                <th>Seen</th>
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
                  <td colSpan={8}>
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
