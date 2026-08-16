/**
 * / — dashboard: headline numbers, freshest high-score prospects, curated
 * source rollup, and the latest crawl run. Public Server Component.
 */
import {
  getDashboardStats,
  listJobs,
  listSourceSummaries,
  type SourceSummary,
} from "@jobscout/core";
import { getDb } from "../lib/db";
import { DifficultyChip, Score, StatusChip, shortDate } from "../lib/chips";
import { SOURCE_META } from "../lib/source-meta";

/**
 * Reads live data, so it must not be prerendered at build time.
 */
export const dynamic = "force-dynamic";


export default async function DashboardPage() {

  const db = getDb();
  const [stats, prospects, sourceSummaries] = await Promise.all([
    getDashboardStats(db),
    listJobs(db, { status: "new", sort: "match_score", limit: 8 }),
    listSourceSummaries(db).catch((): SourceSummary[] => []),
  ]);

  const inbox =
    (stats.statusCounts.new ?? 0) + (stats.statusCounts.notified ?? 0);
  const run = stats.latestRun;

  return (
    <div>
      <section className="rise">
        <p className="kicker">Situation report</p>
        <h1>The week&apos;s reconnaissance</h1>
        <p className="lede">
          {stats.jobsLast7Days} posting{stats.jobsLast7Days === 1 ? "" : "s"}{" "}
          surfaced in the last seven days across {stats.totalCompanies} tracked
          compan{stats.totalCompanies === 1 ? "y" : "ies"}.
        </p>

        <div className="stat-grid">
          <div className="stat stat-accent">
            <div className="label">Inbox</div>
            <div className="value">{inbox}</div>
          </div>
          <div className="stat stat-warn">
            <div className="label">Queued</div>
            <div className="value">{stats.statusCounts.queued ?? 0}</div>
          </div>
          <div className="stat">
            <div className="label">Applied</div>
            <div className="value">{stats.statusCounts.applied ?? 0}</div>
          </div>
          <div className="stat">
            <div className="label">New this week</div>
            <div className="value">{stats.jobsLast7Days}</div>
          </div>
          <div className="stat">
            <div className="label">Companies</div>
            <div className="value">
              {stats.totalCompanies}{" "}
              <small>({stats.curatedCompanies} via sources)</small>
            </div>
          </div>
        </div>
      </section>

      <section className="section rise">
        <div className="section-head">
          <h2>Top prospects</h2>
          <span className="count">
            unreviewed, by match score · <a href="/jobs">full board →</a>
          </span>
        </div>
        {prospects.rows.length === 0 ? (
          <div className="ledger-wrap">
            <p className="empty">Nothing new on the wire.</p>
          </div>
        ) : (
          <div className="ledger-wrap">
            <table className="ledger">
              <thead>
                <tr>
                  <th>Posting</th>
                  <th>Company</th>
                  <th className="num">Score</th>
                  <th>Difficulty</th>
                  <th>Status</th>
                  <th>Seen</th>
                </tr>
              </thead>
              <tbody>
                {prospects.rows.map((job) => (
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
                    <td>
                      <StatusChip value={job.status} />
                    </td>
                    <td className="muted">{shortDate(job.first_seen_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="section rise">
        <div className="section-head">
          <h2>Curated sources</h2>
          <span className="count">
            <a href="/sources">all sources →</a>
          </span>
        </div>
        {sourceSummaries.length === 0 ? (
          <p className="lede">
            No source runs recorded yet — run{" "}
            <code>pnpm -C apps/crawler sources</code> to start tracking the
            seven curated sources.
          </p>
        ) : (
          <div className="ledger-wrap">
            <table className="ledger">
              <thead>
                <tr>
                  <th>Source</th>
                  <th className="num">Companies</th>
                  <th className="num">Items</th>
                  <th>Last processed</th>
                </tr>
              </thead>
              <tbody>
                {sourceSummaries.map((s) => (
                  <tr key={s.source_key}>
                    <td className="title-cell">
                      <a href="/sources">
                        {SOURCE_META[s.source_key]?.label ?? s.source_key}
                      </a>
                    </td>
                    <td className="num">{s.companies}</td>
                    <td className="num">{s.items}</td>
                    <td className="muted">{shortDate(s.last_processed_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="section rise">
        <div className="section-head">
          <h2>Latest crawl</h2>
          <span className="count">
            <a href="/runs">run history →</a>
          </span>
        </div>
        {run ? (
          <p className="lede">
            {run.started_at ? new Date(run.started_at).toLocaleString() : "—"}{" "}
            · trigger <b>{run.trigger}</b> ·{" "}
            <span className={run.ok ? "ok-yes" : "ok-no"}>
              {run.ok ? "OK" : "FAILED"}
            </span>{" "}
            · notified {run.notified_count ?? 0}
          </p>
        ) : (
          <p className="lede">No crawl runs yet.</p>
        )}
      </section>
    </div>
  );
}
