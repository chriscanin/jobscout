/**
 * /jobs — job queue list with filters, sort, and pagination (spec 08 §3).
 * Server Component: reads via listJobs from @jobscout/core, behind requireAllowedUser.
 */
import { listJobs } from "@jobscout/core";
import type { Difficulty, RoleCategory, Source, Status } from "@jobscout/core";
import { getDb } from "../../lib/db";
import { requireAllowedUser } from "../../lib/auth";
import { transitionJobAction } from "../../lib/actions";

const PAGE_SIZE = 50;

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
  const status = sp.status as Status | undefined;
  const difficulty = sp.difficulty as Difficulty | undefined;
  const roleCategory = sp.role_category as RoleCategory | undefined;
  const source = sp.source as Source | undefined;
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
      <h1>Jobs ({total})</h1>

      {/* Filter controls */}
      <form method="get" action="/jobs" style={{ marginBottom: "1rem" }}>
        <label>
          Status:{" "}
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
        </label>{" "}
        <label>
          Difficulty:{" "}
          <select name="difficulty" defaultValue={difficulty ?? ""}>
            <option value="">All</option>
            {(["easy", "medium", "hard", "unknown"] as Difficulty[]).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>{" "}
        <label>
          Category:{" "}
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
        </label>{" "}
        <label>
          Source:{" "}
          <select name="source" defaultValue={source ?? ""}>
            <option value="">All</option>
            {(["greenhouse", "lever", "ashby", "caljobs", "indeed", "ziprecruiter", "discovery"] as Source[]).map(
              (s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ),
            )}
          </select>
        </label>{" "}
        <label>
          Sort:{" "}
          <select name="sort" defaultValue={sort}>
            <option value="first_seen_at">First seen</option>
            <option value="match_score">Match score</option>
          </select>
        </label>{" "}
        <button type="submit">Filter</button>
      </form>

      {/* Jobs table */}
      <table border={1} cellPadding={4} style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th>Title</th>
            <th>Company</th>
            <th>Score</th>
            <th>Difficulty</th>
            <th>Source</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((job) => (
            <tr key={job.id}>
              <td>
                <a href={`/jobs/${job.id}`}>{job.title}</a>
              </td>
              <td>{job.company}</td>
              <td>{job.match_score ?? "—"}</td>
              <td>
                <span
                  style={{
                    background:
                      job.difficulty === "easy"
                        ? "#d4edda"
                        : job.difficulty === "medium"
                          ? "#fff3cd"
                          : job.difficulty === "hard"
                            ? "#f8d7da"
                            : "#e2e3e5",
                    padding: "2px 6px",
                    borderRadius: "4px",
                    fontSize: "0.85em",
                  }}
                >
                  {job.difficulty}
                </span>
              </td>
              <td>{job.source}</td>
              <td>{job.status}</td>
              <td>
                {(job.status === "new" || job.status === "notified") && (
                  <>
                    <form
                      action={async () => {
                        "use server";
                        await transitionJobAction(job.id, "queued");
                      }}
                      style={{ display: "inline" }}
                    >
                      <button type="submit">Queue</button>
                    </form>{" "}
                    <form
                      action={async () => {
                        "use server";
                        await transitionJobAction(job.id, "dismissed");
                      }}
                      style={{ display: "inline" }}
                    >
                      <button type="submit">Dismiss</button>
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
                      style={{ display: "inline" }}
                    >
                      <button type="submit">Applied</button>
                    </form>{" "}
                    <form
                      action={async () => {
                        "use server";
                        await transitionJobAction(job.id, "dismissed");
                      }}
                      style={{ display: "inline" }}
                    >
                      <button type="submit">Dismiss</button>
                    </form>
                  </>
                )}
                {(job.status === "applied" || job.status === "dismissed") && (
                  <form
                    action={async () => {
                      "use server";
                      await transitionJobAction(job.id, "queued");
                    }}
                    style={{ display: "inline" }}
                  >
                    <button type="submit">Undo</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={7}>No jobs found.</td>
            </tr>
          )}
        </tbody>
      </table>

      {/* Pagination */}
      <div style={{ marginTop: "1rem" }}>
        {page > 1 && (
          <a href={filterUrl({ page: String(page - 1) })}>← Prev</a>
        )}{" "}
        Page {page} of {totalPages}{" "}
        {page < totalPages && (
          <a href={filterUrl({ page: String(page + 1) })}>Next →</a>
        )}
      </div>
    </div>
  );
}
