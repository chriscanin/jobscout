"use server";

/**
 * Server Actions for the board (spec 08 §3).
 *
 * All actions:
 * 1. Check who is asking (lib/viewer): tracking needs a signed-in person,
 *    criteria and people need the owner. A Server Action is a public endpoint,
 *    so the check lives here, not only in the UI that hides the buttons.
 * 2. Run the operation through packages/core (never write SQL directly here).
 * 3. Return a discriminated result so UI can show success or error without
 *    throwing across the server/client boundary.
 */

import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  createPerson,
  deletePerson,
  findPersonByToken,
  getCriteria,
  rotatePersonToken,
  touchPerson,
  savePersonNotes,
  setPersonStatus,
  updateCriteria,
  type PersonStatus,
} from "@jobscout/core";
import { getDb } from "./db";
import { PERSON_COOKIE, PERSON_COOKIE_OPTIONS, getViewer } from "./viewer";

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string };

const NOT_SIGNED_IN = "Open your invite link to track postings.";
const OWNER_ONLY = "Only the board owner can do that.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The invite link for a token, on whatever host this request came in on. */
async function inviteLink(token: string): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}/join#${token}`;
}

/**
 * Sign this browser in with an invite token (from /join#<token>) and go to the
 * board. Returns an error for a token that matches nobody.
 */
export async function joinAction(token: string): Promise<ActionResult> {
  const db = getDb();
  const person = await findPersonByToken(db, token);
  if (!person) {
    return { ok: false, error: "That invite link does not work any more. Ask for a new one." };
  }
  await touchPerson(db, person.id);
  (await cookies()).set(PERSON_COOKIE, token, PERSON_COOKIE_OPTIONS);
  redirect("/jobs");
}

/** Forget this browser's invite cookie. */
export async function signOutAction(): Promise<void> {
  (await cookies()).delete(PERSON_COOKIE);
  redirect("/");
}

/**
 * Move the viewer's own status on a job. Called from the board and the job
 * page. Returns an error string on an illegal move or when nobody is signed
 * in; rethrows on unexpected errors.
 */
export async function transitionJobAction(
  jobId: string,
  to: PersonStatus,
): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return { ok: false, error: NOT_SIGNED_IN };
  try {
    await setPersonStatus(getDb(), viewer.id, jobId, to);
    revalidatePath("/jobs");
    revalidatePath(`/jobs/${jobId}`);
    return { ok: true, data: undefined };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "InvalidTransitionError") {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}

/** Save the viewer's own notes on a job. Never changes status. */
export async function saveNotesAction(
  jobId: string,
  notes: string,
): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return { ok: false, error: NOT_SIGNED_IN };
  await savePersonNotes(getDb(), viewer.id, jobId, notes);
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true, data: undefined };
}

/**
 * Submit updated criteria (owner only: they drive scoring and Discord pings
 * for everyone). Validates with the Criteria zod schema (via updateCriteria,
 * which throws before writing on invalid input).
 */
export async function updateCriteriaAction(
  value: unknown,
): Promise<ActionResult<{ fieldErrors?: Record<string, string[]> }>> {
  const viewer = await getViewer();
  if (!viewer?.is_owner) return { ok: false, error: OWNER_ONLY };
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

/** What the invite forms show after a submit: the new link, once. */
export type InviteState =
  | { ok: true; name: string; link: string }
  | { ok: false; error: string }
  | null;

/** Owner: add a person and hand back their invite token. */
export async function addPersonAction(
  _prev: InviteState,
  formData: FormData,
): Promise<InviteState> {
  const viewer = await getViewer();
  if (!viewer?.is_owner) return { ok: false, error: OWNER_ONLY };
  const name = String(formData.get("name") ?? "").trim();
  if (name === "") return { ok: false, error: "Give them a name." };
  const { person, token } = await createPerson(getDb(), { name });
  revalidatePath("/people");
  return { ok: true, name: person.name, link: await inviteLink(token) };
}

/**
 * Owner: issue a new link for a person (the old one stops working). For the
 * owner's own row this browser's cookie moves to the new token, so they stay
 * signed in here and can open the new link elsewhere.
 */
export async function newLinkAction(
  _prev: InviteState,
  formData: FormData,
): Promise<InviteState> {
  const viewer = await getViewer();
  if (!viewer?.is_owner) return { ok: false, error: OWNER_ONLY };
  const personId = String(formData.get("person_id") ?? "");
  const name = String(formData.get("name") ?? "");
  if (!UUID.test(personId)) return { ok: false, error: "That person no longer exists." };
  const token = await rotatePersonToken(getDb(), personId);
  if (!token) return { ok: false, error: "That person no longer exists." };
  if (personId === viewer.id) {
    (await cookies()).set(PERSON_COOKIE, token, PERSON_COOKIE_OPTIONS);
  }
  return { ok: true, name, link: await inviteLink(token) };
}

/** Owner: remove a person and everything they tracked. Owners cannot be removed. */
export async function removePersonAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!viewer?.is_owner) return;
  const personId = String(formData.get("person_id") ?? "");
  if (!UUID.test(personId)) return;
  await deletePerson(getDb(), personId);
  revalidatePath("/people");
}
