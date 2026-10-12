import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db.js";
import type { PersonStatus } from "./enums.js";
import type { Person, PersonJob } from "./schemas.js";
import { InvalidTransitionError, isAllowedPersonalTransition } from "./status.js";

/**
 * People and their per-posting tracking (migration 0006). A person signs in by
 * opening an invite link `/join#<token>`; the token is 192 random bits and only
 * its SHA-256 is stored, so the database never holds a usable link.
 */

const PERSON_COLUMNS = "id, name, is_owner, created_at, last_seen_at";

/** A fresh invite token (URL-safe). */
export function newInviteToken(): string {
  return randomBytes(24).toString("base64url");
}

/** The stored form of an invite token. */
export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Create a person and return them with their invite token (shown once). */
export async function createPerson(
  db: Db,
  input: { name: string; isOwner?: boolean },
): Promise<{ person: Person; token: string }> {
  const name = input.name.trim();
  if (name === "") throw new Error("a person needs a name");
  const token = newInviteToken();
  const result = await db.query(
    `insert into people (name, token_hash, is_owner) values ($1, $2, $3)
     returning ${PERSON_COLUMNS}`,
    [name, hashInviteToken(token), input.isOwner ?? false],
  );
  return { person: result.rows[0] as Person, token };
}

/** The person an invite token belongs to, or null for a missing/unknown token. */
export async function findPersonByToken(
  db: Db,
  token: string | null | undefined,
): Promise<Person | null> {
  if (!token) return null;
  const result = await db.query(
    `select ${PERSON_COLUMNS} from people where token_hash = $1`,
    [hashInviteToken(token)],
  );
  return (result.rows[0] as Person | undefined) ?? null;
}

/** Stamp last_seen_at (called when someone opens their invite link). */
export async function touchPerson(db: Db, personId: string): Promise<void> {
  await db.query(`update people set last_seen_at = now() where id = $1`, [personId]);
}

/** Everyone, oldest first. */
export async function listPeople(db: Db): Promise<Person[]> {
  const result = await db.query(
    `select ${PERSON_COLUMNS} from people order by created_at, name`,
  );
  return result.rows as Person[];
}

/**
 * Issue a new invite token for a person, invalidating the old link. Their
 * statuses and notes are kept. Returns null when the person does not exist.
 */
export async function rotatePersonToken(
  db: Db,
  personId: string,
): Promise<string | null> {
  const token = newInviteToken();
  const result = await db.query(
    `update people set token_hash = $2 where id = $1 returning id`,
    [personId, hashInviteToken(token)],
  );
  return result.rows.length > 0 ? token : null;
}

/**
 * Remove a person and, by cascade, everything they tracked. Owners are never
 * removed this way, so the board cannot be left without one.
 */
export async function deletePerson(db: Db, personId: string): Promise<void> {
  await db.query(`delete from people where id = $1 and not is_owner`, [personId]);
}

/** One person's row for one posting, or null when they have not touched it. */
export async function getPersonJob(
  db: Db,
  personId: string,
  jobId: string,
): Promise<PersonJob | null> {
  const result = await db.query(
    `select * from person_jobs where person_id = $1 and job_id = $2`,
    [personId, jobId],
  );
  return (result.rows[0] as PersonJob | undefined) ?? null;
}

/** The timestamp column stamped on entry to each personal status. */
const ENTERED_AT: Record<PersonStatus, string> = {
  queued: "queued_at",
  applied: "applied_at",
  dismissed: "dismissed_at",
};

/**
 * Move one person's status on a posting, enforcing PERSONAL_TRANSITIONS
 * (throws InvalidTransitionError and writes nothing on an illegal move).
 * Stamps the matching *_at column on first entry and never clears it. The
 * write only lands if the status is still the one checked, so two clicks at
 * once cannot make a move the rules forbid.
 */
export async function setPersonStatus(
  db: Db,
  personId: string,
  jobId: string,
  to: PersonStatus,
): Promise<PersonJob> {
  const current = await getPersonJob(db, personId, jobId);
  const from = current?.status ?? null;
  if (!isAllowedPersonalTransition(from, to)) {
    throw new InvalidTransitionError(from ?? "new", to);
  }
  const col = ENTERED_AT[to];
  const result = await db.query(
    `insert into person_jobs (person_id, job_id, status, ${col})
     values ($1, $2, $3, now())
     on conflict (person_id, job_id) do update set
       status = excluded.status,
       ${col} = coalesce(person_jobs.${col}, now()),
       updated_at = now()
     where person_jobs.status is not distinct from $4::text
     returning *`,
    [personId, jobId, to, from],
  );
  if (result.rows.length === 0) throw new InvalidTransitionError(from ?? "new", to);
  return result.rows[0] as PersonJob;
}

/** Save one person's notes on a posting. Never changes their status. */
export async function savePersonNotes(
  db: Db,
  personId: string,
  jobId: string,
  notes: string,
): Promise<void> {
  await db.query(
    `insert into person_jobs (person_id, job_id, notes) values ($1, $2, $3)
     on conflict (person_id, job_id) do update set
       notes = excluded.notes,
       updated_at = now()`,
    [personId, jobId, notes],
  );
}
