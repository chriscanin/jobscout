/**
 * /jobs/[id] — job dossier (spec 08 §3).
 * Shows description, match_reasons, difficulty_reasons, application questions
 * from raw, url/apply_url links, and, for a signed-in person, their own status
 * buttons and private notes.
 */
import { notFound } from "next/navigation";
import { getJob, getPersonJob } from "@jobscout/core";
import { getDb } from "../../../lib/db";
import { getViewer } from "../../../lib/viewer";
import { transitionJobAction, saveNotesAction } from "../../../lib/actions";
import { DifficultyChip, Score, StatusChip } from "../../../lib/chips";
import { movesFor } from "../../../lib/moves";
import { safeDescription } from "../../../lib/description";

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {

  const { id } = await params;
  const db = getDb();
  const job = await getJob(db, id);
  if (!job) notFound();
  const viewer = await getViewer();
  const mine = viewer ? await getPersonJob(db, viewer.id, id) : null;

  const questions =
    job.raw != null &&
    typeof job.raw === "object" &&
    "questions" in (job.raw as object)
      ? (job.raw as { questions: unknown }).questions
      : null;

  const moves = movesFor(mine?.status ?? null);

  return (
    <div>
      <section className="rise">
        <p className="kicker">Dossier</p>
        <h1>{job.title}</h1>
        <div className="dossier-meta">
          <b style={{ color: "var(--ink)" }}>{job.company}</b>
          <span>·</span>
          <span>{job.source}</span>
          {mine?.status && <StatusChip value={mine.status} />}
          {job.status === "expired" && <StatusChip value="expired" />}
          <DifficultyChip value={job.difficulty} />
          {job.location && (
            <>
              <span>·</span>
              <span>{job.location}</span>
            </>
          )}
          {job.salary_raw && (
            <>
              <span>·</span>
              <span>{job.salary_raw}</span>
            </>
          )}
        </div>
        <p>
          {job.url && (
            <a href={job.url} target="_blank" rel="noreferrer" className="btn">
              View posting ↗
            </a>
          )}{" "}
          {job.apply_url && (
            <a
              href={job.apply_url}
              target="_blank"
              rel="noreferrer"
              className="btn btn-primary"
            >
              Apply ↗
            </a>
          )}
        </p>
      </section>

      <div className="dossier-grid section rise">
        <div>
          {job.description && (
            <div className="panel">
              <h2>Description</h2>
              <div
                className="description-body"
                dangerouslySetInnerHTML={{ __html: safeDescription(job.description) }}
              />
            </div>
          )}

          <div className="panel">
            <h2>Application questions</h2>
            {questions ? (
              <pre className="raw">{JSON.stringify(questions, null, 2)}</pre>
            ) : (
              <p className="muted">none captured</p>
            )}
          </div>

          {viewer && (
            <div className="panel">
              <h2>My notes</h2>
              <form
                action={async (formData: FormData) => {
                  "use server";
                  const notes = formData.get("notes") as string;
                  await saveNotesAction(id, notes ?? "");
                }}
              >
                <textarea name="notes" defaultValue={mine?.notes ?? ""} rows={6} />
                <p style={{ marginTop: "0.5rem" }}>
                  <button type="submit" className="btn">
                    Save notes
                  </button>
                  <span className="muted"> only you see these</span>
                </p>
              </form>
            </div>
          )}
        </div>

        <aside>
          <div className="panel">
            <h2>Match</h2>
            <p style={{ fontSize: "1.6rem", fontFamily: "var(--font-display)" }}>
              <Score value={job.match_score} />
              <span style={{ fontSize: "0.8rem", color: "var(--ink-faint)" }}>
                {" "}
                / 100
              </span>
            </p>
            {job.match_reasons && job.match_reasons.length > 0 && (
              <ul>
                {job.match_reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            )}
          </div>

          <div className="panel">
            <h2>Difficulty — {job.difficulty}</h2>
            {job.difficulty_reasons && job.difficulty_reasons.length > 0 ? (
              <ul>
                {job.difficulty_reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">no reasons recorded</p>
            )}
          </div>

          <div className="panel">
            <h2>My status</h2>
            {!viewer ? (
              <p className="muted">
                Open the invite link you were sent to queue, mark applied or
                dismiss postings.
              </p>
            ) : (
              moves.map((move) => (
                <form
                  key={move.to}
                  action={async () => {
                    "use server";
                    await transitionJobAction(id, move.to);
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
              ))
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
