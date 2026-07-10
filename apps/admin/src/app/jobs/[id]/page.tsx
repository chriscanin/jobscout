/**
 * /jobs/[id] — job detail page (spec 08 §3).
 * Shows description, match_reasons, difficulty_reasons, application questions from raw,
 * url/apply_url links, status action buttons, and an editable notes field.
 */
import { notFound } from "next/navigation";
import { getJob, isAllowedTransition } from "@jobscout/core";
import type { Status } from "@jobscout/core";
import { getDb } from "../../../lib/db";
import { requireAllowedUser } from "../../../lib/auth";
import { transitionJobAction, saveNotesAction } from "../../../lib/actions";

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Redirects (null session) or 403s (non-allowlisted) before any DB access.
  await requireAllowedUser();

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
  // Candidates are typed as Status so isAllowedTransition receives the right type.
  const candidates: Array<{ label: string; to: Status }> = [
    { label: "Queue", to: "queued" },
    { label: "Applied", to: "applied" },
    { label: "Dismiss", to: "dismissed" },
  ];
  const enabledButtons: Array<{ label: string; to: Status }> = [];
  for (const candidate of candidates) {
    if (isAllowedTransition(job.status, candidate.to)) {
      // For "queued" target: label is "Undo" when coming from applied/dismissed
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
      <h1>{job.title}</h1>
      <p>
        <strong>{job.company}</strong> · {job.source} · {job.status}
      </p>

      <p>
        {job.url && (
          <a href={job.url} target="_blank" rel="noreferrer">
            View posting
          </a>
        )}
        {job.apply_url && (
          <>
            {" "}·{" "}
            <a href={job.apply_url} target="_blank" rel="noreferrer">
              Apply
            </a>
          </>
        )}
      </p>

      {/* Match info */}
      <section>
        <h2>Match</h2>
        <p>Score: {job.match_score ?? "—"}</p>
        {job.match_reasons && job.match_reasons.length > 0 && (
          <ul>
            {job.match_reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        )}
      </section>

      {/* Difficulty */}
      <section>
        <h2>Difficulty: {job.difficulty}</h2>
        {job.difficulty_reasons && job.difficulty_reasons.length > 0 && (
          <ul>
            {job.difficulty_reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        )}
      </section>

      {/* Application questions */}
      <section>
        <h2>Application questions</h2>
        {questions ? (
          <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.85em" }}>
            {JSON.stringify(questions, null, 2)}
          </pre>
        ) : (
          <p>none captured</p>
        )}
      </section>

      {/* Description */}
      {job.description && (
        <section>
          <h2>Description</h2>
          <div
            style={{ maxHeight: "400px", overflow: "auto", fontSize: "0.9em" }}
            dangerouslySetInnerHTML={{ __html: job.description }}
          />
        </section>
      )}

      {/* Status actions */}
      <section>
        <h2>Status</h2>
        <p>Current: {job.status}</p>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          {enabledButtons.map((btn) => (
            <form
              key={btn.label}
              action={async () => {
                "use server";
                await transitionJobAction(id, btn.to);
              }}
            >
              <button type="submit">{btn.label}</button>
            </form>
          ))}
          {enabledButtons.length === 0 && <p>No actions available.</p>}
        </div>
      </section>

      {/* Notes */}
      <section>
        <h2>Notes</h2>
        <form
          action={async (formData: FormData) => {
            "use server";
            const notes = formData.get("notes") as string;
            await saveNotesAction(id, notes ?? "");
          }}
        >
          <textarea
            name="notes"
            defaultValue={job.notes ?? ""}
            rows={6}
            cols={80}
          />
          <br />
          <button type="submit">Save notes</button>
        </form>
      </section>
    </div>
  );
}
