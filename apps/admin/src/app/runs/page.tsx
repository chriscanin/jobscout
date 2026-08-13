/**
 * /runs — crawl_runs history (spec 08 §3).
 * Shows per-source stats + errors so a broken source is visible without ssh.
 */
import { listCrawlRuns } from "@jobscout/core";
import { getDb } from "../../lib/db";
import { requireAllowedUser } from "../../lib/auth";

export default async function RunsPage() {
  // Redirects (null session) or 403s (non-allowlisted) before any DB access.
  await requireAllowedUser();

  const db = getDb();
  const runs = await listCrawlRuns(db, { limit: 50 });

  return (
    <div>
      <section className="rise">
        <p className="kicker">The wire log</p>
        <h1>Crawl runs</h1>
        <p className="lede">
          Every cycle, newest first — per-source fetch stats and errors, so a
          broken source is visible without ssh.
        </p>
      </section>

      <section className="section rise">
        {runs.length === 0 && (
          <div className="ledger-wrap">
            <p className="empty">No crawl runs yet.</p>
          </div>
        )}
        {runs.map((run) => {
          const stats =
            run.stats != null && typeof run.stats === "object"
              ? (run.stats as Record<
                  string,
                  { fetched: number; new: number; updated: number; errors: string[] }
                >)
              : {};

          return (
            <details key={run.id} className="run">
              <summary>
                <span>
                  {run.started_at
                    ? new Date(run.started_at).toLocaleString()
                    : "unknown"}
                </span>
                <span className="chip chip-unknown">{run.trigger}</span>
                <span className={run.ok ? "ok-yes" : "ok-no"}>
                  {run.ok ? "OK" : "FAILED"}
                </span>
                <span style={{ color: "var(--ink-soft)" }}>
                  notified {run.notified_count ?? 0}
                </span>
              </summary>
              <div className="run-body">
                <div className="ledger-wrap" style={{ boxShadow: "none" }}>
                  <table className="ledger">
                    <thead>
                      <tr>
                        <th>Source</th>
                        <th className="num">Fetched</th>
                        <th className="num">New</th>
                        <th className="num">Updated</th>
                        <th>Errors</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(stats).map(([src, s]) => (
                        <tr key={src}>
                          <td>{src}</td>
                          <td className="num">{s.fetched}</td>
                          <td className="num">{s.new}</td>
                          <td className="num">{s.updated}</td>
                          <td>
                            {s.errors && s.errors.length > 0 ? (
                              <ul style={{ margin: 0, paddingLeft: "1em" }}>
                                {s.errors.map((e, i) => (
                                  <li key={i} className="error-text">
                                    {e}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              "—"
                            )}
                          </td>
                        </tr>
                      ))}
                      {Object.keys(stats).length === 0 && (
                        <tr>
                          <td colSpan={5} className="muted">
                            No stats recorded.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <p style={{ fontSize: "11px", color: "var(--ink-soft)", marginTop: "0.5rem" }}>
                  Finished:{" "}
                  {run.finished_at
                    ? new Date(run.finished_at).toLocaleString()
                    : "—"}
                </p>
              </div>
            </details>
          );
        })}
      </section>
    </div>
  );
}
