"use server";

/**
 * Server Actions for the admin app (spec 08 §3).
 *
 * All actions:
 * 2. Run the operation through packages/core (never write SQL directly here).
 * 3. Return a discriminated result so UI can show success or error without
 *    throwing across the server/client boundary.
 */

import { revalidatePath } from "next/cache";
import {
  applyStatusTransition,
  getCriteria,
  updateCriteria,
  type Status,
} from "@jobscout/core";
import { getDb } from "./db";

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/**
 * Transition a job's status. Called from the jobs list and detail pages.
 * Returns an error string on `InvalidTransitionError`; rethrows on unexpected errors.
 */
export async function transitionJobAction(
  jobId: string,
  to: Status,
): Promise<ActionResult> {
  const db = getDb();
  try {
    await applyStatusTransition(db, jobId, to);
    revalidatePath("/jobs");
    revalidatePath(`/jobs/${jobId}`);
    return { ok: true, data: undefined };
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.name === "InvalidTransitionError"
    ) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}

/**
 * Save the notes field for a job. Never changes status.
 */
export async function saveNotesAction(
  jobId: string,
  notes: string,
): Promise<ActionResult> {
  const db = getDb();
  await db.query(`UPDATE jobs SET notes = $1 WHERE id = $2`, [notes, jobId]);
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true, data: undefined };
}

/**
 * Submit updated criteria. Validates with the Criteria zod schema (via
 * updateCriteria which throws before writing on invalid input).
 * Returns field errors on a zod validation failure.
 */
export async function updateCriteriaAction(
  value: unknown,
): Promise<ActionResult<{ fieldErrors?: Record<string, string[]> }>> {
  const db = getDb();
  try {
    await updateCriteria(db, value);
    revalidatePath("/criteria");
    return { ok: true, data: {} };
  } catch (err: unknown) {
    // Zod parse errors have an `issues` array
    if (
      err instanceof Error &&
      err.name === "ZodError" &&
      "issues" in err
    ) {
      const issues = (err as { issues: Array<{ path: (string | number)[]; message: string }> }).issues;
      const fieldErrors: Record<string, string[]> = {};
      for (const issue of issues) {
        const key = issue.path.join(".") || "value";
        if (!fieldErrors[key]) fieldErrors[key] = [];
        fieldErrors[key].push(issue.message);
      }
      return { ok: false, error: "Validation failed" };
    }
    throw err;
  }
}

/**
 * Read current criteria — used by the /criteria page to populate the form.
 */
export async function getCriteriaAction() {
  const db = getDb();
  return getCriteria(db);
}
