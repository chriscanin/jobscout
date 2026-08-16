/**
 * /jobs/[id] — job dossier (spec 08 §3).
 * Shows description, match_reasons, difficulty_reasons, application questions
 * from raw, url/apply_url links, status action buttons, and editable notes.
 */
import { notFound } from "next/navigation";
import { getJob, isAllowedTransition } from "@jobscout/core";
import type { Status } from "@jobscout/core";
import { getDb } from "../../../lib/db";
import { transitionJobAction, saveNotesAction } from "../../../lib/actions";
import { DifficultyChip, Score, StatusChip } from "../../../lib/chips";

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {

  const { id } = await params;
  const db = getDb();
  const job = await getJob(db, id);
  if (!job) notFound();

  const questions =
    job.raw != null &&
    typeof job.raw === "object" &&
    "questions" in (job.raw as object)
      ? (job.raw as { questions: unknown }).questions
      : null;

  // Build unique enabled buttons: for each legal target status, pick the right label.
  const candidates: Array<{ label: string; to: Status }> = [
    { label: "Queue", to: "queued" },
    { label: "Applied", to: "applied" },
    { label: "Dismiss", to: "dismissed" },
  ];
  const enabledButtons: Array<{ label: string; to: Status }> = [];
  for (const candidate of candidates) {
    if (isAllowedTransition(job.status, candidate.to)) {
      const label =
        candidate.to === "queued" &&
        (job.status === "applied" || job.status === "dismissed")
          ? "Undo"
          : candidate.label;
      enabledButtons.push({ label, to: candidate.to });
    }
  }

  return (
    <div>
      <section className="rise">
        <p className="kicker">Dossier</p>
        <h1>{job.title}</h1>
        <div className="dossier-meta">
          <b style={{ color: "var(--ink)" }}>{job.company}</b>
          <span>·</span>
          <span>{job.source}</span>
          <StatusChip value={job.status} />
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
                dangerouslySetInnerHTML={{ __html: job.description }}
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

          <div className="panel">
            <h2>Notes</h2>
            <form
              action={async (formData: FormData) => {
                "use server";
                const notes = formData.get("notes") as string;
                await saveNotesAction(id, notes ?? "");
              }}
            >
              <textarea name="notes" defaultValue={job.notes ?? ""} rows={6} />
              <p style={{ marginTop: "0.5rem" }}>
                <button type="submit" className="btn">
                  Save notes
                </button>
              </p>
            </form>
          </div>
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
            <h2>Move</h2>
            {enabledButtons.length === 0 && (
              <p className="muted">No actions available.</p>
            )}
            {enabledButtons.map((btn) => (
              <form
                key={btn.label}
                action={async () => {
                  "use server";
                  await transitionJobAction(id, btn.to);
                }}
                className="inline-form"
              >
                <button
                  type="submit"
                  className={btn.to === "dismissed" ? "btn btn-quiet" : "btn btn-primary"}
                >
                  {btn.label}
                </button>
              </form>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
