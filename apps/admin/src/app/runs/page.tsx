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
      <h1>Crawl Runs</h1>
      {runs.length === 0 && <p>No crawl runs yet.</p>}
      {runs.map((run) => {
        const stats =
          run.stats != null && typeof run.stats === "object"
            ? (run.stats as Record<
                string,
                { fetched: number; new: number; updated: number; errors: string[] }
              >)
            : {};

        return (
          <details key={run.id} style={{ marginBottom: "1rem" }}>
            <summary>
              {run.started_at
                ? new Date(run.started_at).toLocaleString()
                : "unknown"}{" "}
              — {run.trigger} —{" "}
              <strong style={{ color: run.ok ? "green" : "red" }}>
                {run.ok ? "OK" : "FAILED"}
              </strong>{" "}
              (notified: {run.notified_count ?? 0})
            </summary>
            <table
              border={1}
              cellPadding={4}
              style={{ borderCollapse: "collapse", marginTop: "0.5rem" }}
            >
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Fetched</th>
                  <th>New</th>
                  <th>Updated</th>
                  <th>Errors</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(stats).map(([src, s]) => (
                  <tr key={src}>
                    <td>{src}</td>
                    <td>{s.fetched}</td>
                    <td>{s.new}</td>
                    <td>{s.updated}</td>
                    <td>
                      {s.errors && s.errors.length > 0 ? (
                        <ul style={{ margin: 0, paddingLeft: "1em" }}>
                          {s.errors.map((e, i) => (
                            <li key={i} style={{ color: "red" }}>
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
                    <td colSpan={5}>No stats recorded.</td>
                  </tr>
                )}
              </tbody>
            </table>
            <p style={{ fontSize: "0.85em", color: "#666" }}>
              Finished:{" "}
              {run.finished_at
                ? new Date(run.finished_at).toLocaleString()
                : "—"}
            </p>
          </details>
        );
      })}
    </div>
  );
}
