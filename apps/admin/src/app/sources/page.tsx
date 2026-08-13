/**
 * /sources — the seven curated startup-intel sources and the companies they
 * have discovered. Server Component behind requireAllowedUser.
 */
import {
  CuratedSourceKey,
  listCompanies,
  listSourceSummaries,
  type Company,
  type SourceSummary,
} from "@jobscout/core";
import { getDb } from "../../lib/db";
import { requireAllowedUser } from "../../lib/auth";
import { shortDate } from "../../lib/chips";
import { SOURCE_META } from "../../lib/source-meta";

const PAGE_SIZE = 50;

interface SearchParams {
  via?: string;
  page?: string;
}

export default async function SourcesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireAllowedUser();

  const sp = await searchParams;
  const viaParsed = CuratedSourceKey.safeParse(sp.via);
  const via = viaParsed.success ? viaParsed.data : undefined;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);

  const db = getDb();
  const [summaries, discovered] = await Promise.all([
    listSourceSummaries(db).catch((): SourceSummary[] => []),
    listCompanies(db, {
      discoveredVia: via,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }).catch(() => ({ rows: [] as Company[], total: 0 })),
  ]);

  const byKey = new Map(summaries.map((s) => [s.source_key, s]));
  const totalPages = Math.ceil(discovered.total / PAGE_SIZE) || 1;

  return (
    <div>
      <section className="rise">
        <p className="kicker">Where the leads come from</p>
        <h1>Curated sources</h1>
        <p className="lede">
          Seven feeds watched daily for breakout startups before their roles hit
          the big boards. Extracted companies land in the crawl rotation
          automatically; Discord pings when their postings match.
        </p>
      </section>

      <section className="section rise">
        <div className="card-grid">
          {(Object.keys(SOURCE_META) as CuratedSourceKey[]).map((key) => {
            const meta = SOURCE_META[key];
            const summary = byKey.get(key);
            return (
              <article className="card" key={key}>
                <div className="card-kind">{meta.cadence}</div>
                <h3>
                  <a href={meta.href} target="_blank" rel="noreferrer">
                    {meta.label}
                  </a>
                </h3>
                <p className="card-desc">{meta.description}</p>
                <div className="card-stats">
                  <div>
                    <b>{summary?.companies ?? 0}</b>
                    <span>companies</span>
                  </div>
                  <div>
                    <b>{summary?.items ?? 0}</b>
                    <span>items read</span>
                  </div>
                  <div>
                    <b>{summary ? shortDate(summary.last_processed_at) : "—"}</b>
                    <span>last run</span>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="section rise">
        <div className="section-head">
          <h2>Tracked companies</h2>
          <span className="count">{discovered.total} total</span>
        </div>

        <form method="get" action="/sources" className="filter-bar">
          <label>
            Discovered via
            <select name="via" defaultValue={via ?? ""}>
              <option value="">All curated + legacy</option>
              {(Object.keys(SOURCE_META) as CuratedSourceKey[]).map((key) => (
                <option key={key} value={key}>
                  {SOURCE_META[key].label}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn">
            Filter
          </button>
        </form>

        {discovered.rows.length === 0 ? (
          <div className="ledger-wrap">
            <p className="empty">
              No companies yet — the sources command hasn&apos;t run, or the
              filter is empty.
            </p>
          </div>
        ) : (
          <div className="ledger-wrap">
            <table className="ledger">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>ATS</th>
                  <th>Board / careers</th>
                  <th>Discovered via</th>
                  <th>Added</th>
                </tr>
              </thead>
              <tbody>
                {discovered.rows.map((c) => {
                  const meta =
                    c.discovered_via in SOURCE_META
                      ? SOURCE_META[c.discovered_via as CuratedSourceKey]
                      : null;
                  return (
                    <tr key={c.id}>
                      <td className="title-cell">{c.name}</td>
                      <td className="muted">{c.ats}</td>
                      <td className="muted">
                        {c.board_token ??
                          (c.careers_url ? (
                            <a href={c.careers_url} target="_blank" rel="noreferrer">
                              {c.careers_url.replace(/^https?:\/\//, "")}
                            </a>
                          ) : (
                            "—"
                          ))}
                      </td>
                      <td>
                        <span className="chip chip-unknown">
                          {meta?.label ?? c.discovered_via}
                        </span>
                      </td>
                      <td className="muted">{shortDate(c.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="pager">
          {page > 1 && (
            <a href={`/sources?${new URLSearchParams({ ...(via ? { via } : {}), page: String(page - 1) })}`}>
              ← Prev
            </a>
          )}
          <span>
            Page {page} of {totalPages}
          </span>
          {page < totalPages && (
            <a href={`/sources?${new URLSearchParams({ ...(via ? { via } : {}), page: String(page + 1) })}`}>
              Next →
            </a>
          )}
        </div>
      </section>
    </div>
  );
}
