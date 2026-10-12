import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertJob } from "../src/data.js";
import { createPgliteTestDb, type Db } from "../src/db.js";
import {
  createPerson,
  deletePerson,
  findPersonByToken,
  getPersonJob,
  hashInviteToken,
  listPeople,
  rotatePersonToken,
  savePersonNotes,
  setPersonStatus,
} from "../src/people.js";
import { getDashboardStats, listJobs } from "../src/queries.js";
import type { RawJob } from "../src/schemas.js";
import { InvalidTransitionError } from "../src/status.js";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createPgliteTestDb());
});

afterEach(async () => {
  await close();
});

let _seq = 0;
async function addJob(overrides: Partial<RawJob> = {}): Promise<string> {
  const n = ++_seq;
  const { job } = await upsertJob(db, {
    source: "greenhouse",
    externalId: `people-${n}`,
    url: `https://example.com/jobs/${n}`,
    title: `React Native Engineer ${n}`,
    company: `Company ${n}`,
    raw: {},
    ...overrides,
  });
  return job.id;
}

describe("invite tokens", () => {
  it("stores only the hash and finds the person by the token", async () => {
    const { person, token } = await createPerson(db, { name: "  Sam  " });
    expect(person.name).toBe("Sam");
    expect(person.is_owner).toBe(false);

    const stored = await db.query(`select token_hash from people where id = $1`, [person.id]);
    expect(stored.rows[0].token_hash).toBe(hashInviteToken(token));
    expect(stored.rows[0].token_hash).not.toContain(token);

    expect((await findPersonByToken(db, token))?.id).toBe(person.id);
    expect(await findPersonByToken(db, "not-a-token")).toBeNull();
    expect(await findPersonByToken(db, "")).toBeNull();
    expect(await findPersonByToken(db, undefined)).toBeNull();
  });

  it("rejects an empty name", async () => {
    await expect(createPerson(db, { name: "   " })).rejects.toThrow();
  });

  it("a new link replaces the old one and keeps the person's tracking", async () => {
    const { person, token: oldToken } = await createPerson(db, { name: "Sam" });
    const jobId = await addJob();
    await setPersonStatus(db, person.id, jobId, "queued");

    const newToken = await rotatePersonToken(db, person.id);
    expect(newToken).not.toBeNull();
    expect(await findPersonByToken(db, oldToken)).toBeNull();
    expect((await findPersonByToken(db, newToken))?.id).toBe(person.id);
    expect((await getPersonJob(db, person.id, jobId))?.status).toBe("queued");

    expect(await rotatePersonToken(db, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("an owner is never removed", async () => {
    const { person } = await createPerson(db, { name: "Chris", isOwner: true });
    await deletePerson(db, person.id);
    expect((await listPeople(db)).map((p) => p.id)).toEqual([person.id]);
  });

  it("removing a person removes their tracking", async () => {
    const { person } = await createPerson(db, { name: "Sam" });
    const jobId = await addJob();
    await setPersonStatus(db, person.id, jobId, "queued");
    await deletePerson(db, person.id);
    expect(await listPeople(db)).toEqual([]);
    expect(await getPersonJob(db, person.id, jobId)).toBeNull();
  });
});

describe("setPersonStatus", () => {
  it("keeps each person's status separate", async () => {
    const { person: chris } = await createPerson(db, { name: "Chris", isOwner: true });
    const { person: sam } = await createPerson(db, { name: "Sam" });
    const jobId = await addJob();

    await setPersonStatus(db, chris.id, jobId, "queued");
    await setPersonStatus(db, chris.id, jobId, "applied");
    await setPersonStatus(db, sam.id, jobId, "dismissed");

    expect((await getPersonJob(db, chris.id, jobId))?.status).toBe("applied");
    expect((await getPersonJob(db, sam.id, jobId))?.status).toBe("dismissed");
    // The crawler's global status is untouched.
    const job = await db.query(`select status from jobs where id = $1`, [jobId]);
    expect(job.rows[0].status).toBe("new");
  });

  it("rejects an illegal move and writes nothing", async () => {
    const { person } = await createPerson(db, { name: "Sam" });
    const jobId = await addJob();
    await expect(setPersonStatus(db, person.id, jobId, "applied")).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
    expect(await getPersonJob(db, person.id, jobId)).toBeNull();
  });

  it("stamps the entry time once and keeps notes", async () => {
    const { person } = await createPerson(db, { name: "Sam" });
    const jobId = await addJob();
    await savePersonNotes(db, person.id, jobId, "referral from Alex");
    expect((await getPersonJob(db, person.id, jobId))?.status).toBeNull();

    const first = await setPersonStatus(db, person.id, jobId, "queued");
    await setPersonStatus(db, person.id, jobId, "dismissed");
    const again = await setPersonStatus(db, person.id, jobId, "queued");
    expect(String(again.queued_at)).toBe(String(first.queued_at));
    expect(again.dismissed_at).not.toBeNull();
    expect(again.notes).toBe("referral from Alex");
  });
});

describe("listJobs with a viewer", () => {
  it("returns the viewer's own status and filters on it", async () => {
    const { person: chris } = await createPerson(db, { name: "Chris" });
    const { person: sam } = await createPerson(db, { name: "Sam" });
    const queued = await addJob();
    const dismissed = await addJob();
    const untouched = await addJob();
    await setPersonStatus(db, chris.id, queued, "queued");
    await setPersonStatus(db, chris.id, dismissed, "dismissed");
    await setPersonStatus(db, sam.id, untouched, "queued");
    await savePersonNotes(db, chris.id, queued, "ping recruiter");

    const all = await listJobs(db, { viewerId: chris.id, limit: 10 });
    const byId = new Map(all.rows.map((r) => [r.id, r]));
    expect(byId.get(queued)?.my_status).toBe("queued");
    expect(byId.get(queued)?.my_notes).toBe("ping recruiter");
    expect(byId.get(untouched)?.my_status).toBeNull(); // Sam's status is not Chris's

    const mineQueued = await listJobs(db, { viewerId: chris.id, mine: "queued" });
    expect(mineQueued.rows.map((r) => r.id)).toEqual([queued]);

    const unreviewed = await listJobs(db, { viewerId: chris.id, mine: "unreviewed" });
    expect(unreviewed.rows.map((r) => r.id)).toEqual([untouched]);

    const open = await listJobs(db, { viewerId: chris.id, hideMyDismissed: true });
    expect(open.rows.map((r) => r.id).sort()).toEqual([queued, untouched].sort());
    expect(open.total).toBe(2);

    const anonymous = await listJobs(db, { mine: "queued", hideMyDismissed: true });
    expect(anonymous.total).toBe(3);
    expect(anonymous.rows.every((r) => r.my_status === null)).toBe(true);
  });

  it("hideNonMatches keeps prescreen rejects the viewer acted on", async () => {
    const { person } = await createPerson(db, { name: "Chris" });
    const rejectQueued = await addJob({ title: "Staff Mobile Engineer" });
    const rejectIgnored = await addJob({ title: "Account Executive" });
    await db.query(`update jobs set match_score = 0 where id = any($1)`, [
      [rejectQueued, rejectIgnored],
    ]);
    await setPersonStatus(db, person.id, rejectQueued, "queued");

    const result = await listJobs(db, { viewerId: person.id, hideNonMatches: true });
    expect(result.rows.map((r) => r.id)).toEqual([rejectQueued]);
  });
});

describe("getDashboardStats with a viewer", () => {
  it("counts the viewer's own statuses and their unreviewed open matches", async () => {
    const { person } = await createPerson(db, { name: "Chris" });
    const a = await addJob();
    const b = await addJob();
    await addJob();
    const reject = await addJob();
    await db.query(`update jobs set match_score = 0 where id = $1`, [reject]);
    await setPersonStatus(db, person.id, a, "queued");
    await setPersonStatus(db, person.id, b, "dismissed");

    const mine = await getDashboardStats(db, person.id);
    expect(mine.mine).toEqual({ queued: 1, applied: 0, dismissed: 1 });
    expect(mine.openMatches).toBe(1);

    const anonymous = await getDashboardStats(db);
    expect(anonymous.mine).toBeNull();
    expect(anonymous.openMatches).toBe(3);
  });
});
