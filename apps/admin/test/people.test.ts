/**
 * Per-person tracking on the board: who may do what, and the invite link.
 * Server Actions are public endpoints, so the checks under test are the ones
 * inside lib/actions.ts, not the UI that hides buttons.
 *
 * Next's request APIs are stubbed: `cookies()` reads a plain object, `getDb()`
 * returns an in-process PGlite database with every migration applied.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CRITERIA,
  PERSONAL_TRANSITIONS,
  createPerson,
  createPgliteTestDb,
  findPersonByToken,
  getCriteria,
  getPersonJob,
  isAllowedPersonalTransition,
  listPeople,
  upsertJob,
  type Db,
  type PersonStatus,
} from "@jobscout/core";

let db: Db;
let closeDb: () => Promise<void>;
let cookieJar: Record<string, string> = {};
const REDIRECT = "NEXT_REDIRECT";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieJar[name] === undefined ? undefined : { name, value: cookieJar[name] },
    set: (name: string, value: string) => {
      cookieJar[name] = value;
    },
    delete: (name: string) => {
      delete cookieJar[name];
    },
  }),
  headers: async () => new Headers({ host: "board.test", "x-forwarded-proto": "https" }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error(REDIRECT), { to });
  },
}));
vi.mock("../src/lib/db", () => ({ getDb: () => db }));

const actions = await import("../src/lib/actions");
const { PERSON_COOKIE } = await import("../src/lib/viewer");
const { movesFor } = await import("../src/lib/moves");
const { safeDescription } = await import("../src/lib/description");

/** Run an action that ends in redirect(); return where it went. */
async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (err instanceof Error && err.message === REDIRECT) return (err as Error & { to: string }).to;
    throw err;
  }
  throw new Error("expected a redirect");
}

beforeEach(async () => {
  ({ db, close: closeDb } = await createPgliteTestDb());
  cookieJar = {};
});

afterEach(async () => {
  await closeDb();
});

async function addJob(): Promise<string> {
  const { job } = await upsertJob(db, {
    source: "greenhouse",
    externalId: `admin-people-${Math.random()}`,
    url: "https://example.com/job",
    title: "React Native Engineer",
    company: "Acme",
    raw: {},
  });
  return job.id;
}

function signInAs(token: string) {
  cookieJar = { [PERSON_COOKIE]: token };
}

describe("tracking actions", () => {
  it("refuse anyone without an invite cookie and write nothing", async () => {
    const jobId = await addJob();
    const result = await actions.transitionJobAction(jobId, "queued");
    expect(result.ok).toBe(false);
    const notes = await actions.saveNotesAction(jobId, "hi");
    expect(notes.ok).toBe(false);
    const rows = await db.query(`select count(*)::int n from person_jobs`);
    expect(rows.rows[0].n).toBe(0);
  });

  it("refuse a cookie whose link was replaced", async () => {
    const { person } = await createPerson(db, { name: "Sam" });
    signInAs("an-old-or-made-up-token");
    const result = await actions.transitionJobAction(await addJob(), "queued");
    expect(result.ok).toBe(false);
    expect(await listPeople(db)).toHaveLength(1);
    expect(person.name).toBe("Sam");
  });

  it("move only the signed-in person's own status", async () => {
    const { person: sam, token } = await createPerson(db, { name: "Sam" });
    const { person: alex } = await createPerson(db, { name: "Alex" });
    const jobId = await addJob();
    signInAs(token);

    expect((await actions.transitionJobAction(jobId, "queued")).ok).toBe(true);
    expect((await actions.saveNotesAction(jobId, "call Monday")).ok).toBe(true);

    const mine = await getPersonJob(db, sam.id, jobId);
    expect(mine?.status).toBe("queued");
    expect(mine?.notes).toBe("call Monday");
    expect(await getPersonJob(db, alex.id, jobId)).toBeNull();

    const illegal = await actions.transitionJobAction(jobId, "queued");
    expect(illegal.ok).toBe(false);
  });
});

describe("owner-only actions", () => {
  it("only the owner can change criteria", async () => {
    const { token: friend } = await createPerson(db, { name: "Sam" });
    const { token: owner } = await createPerson(db, { name: "Chris", isOwner: true });
    const changed = { ...DEFAULT_CRITERIA, notify_min_score: 77 };

    signInAs(friend);
    expect((await actions.updateCriteriaAction(changed)).ok).toBe(false);
    expect((await getCriteria(db)).notify_min_score).not.toBe(77);

    signInAs(owner);
    expect((await actions.updateCriteriaAction(changed)).ok).toBe(true);
    expect((await getCriteria(db)).notify_min_score).toBe(77);
  });

  it("only the owner can add people, and the link they get works", async () => {
    const { token: friend } = await createPerson(db, { name: "Sam" });
    const { token: owner } = await createPerson(db, { name: "Chris", isOwner: true });
    const form = new FormData();
    form.set("name", "Jordan");

    signInAs(friend);
    expect((await actions.addPersonAction(null, form))?.ok).toBe(false);
    expect(await listPeople(db)).toHaveLength(2);

    signInAs(owner);
    const added = await actions.addPersonAction(null, form);
    expect(added?.ok).toBe(true);
    if (!added?.ok) throw new Error("unreachable");
    expect((await findPersonByToken(db, added.link.split("#")[1]))?.name).toBe("Jordan");
  });

  it("a new link replaces the old one; the owner cannot remove themself", async () => {
    const { person: sam, token: samOld } = await createPerson(db, { name: "Sam" });
    const { person: chris, token: owner } = await createPerson(db, {
      name: "Chris",
      isOwner: true,
    });
    signInAs(owner);

    const linkForm = new FormData();
    linkForm.set("person_id", sam.id);
    linkForm.set("name", sam.name);
    const relinked = await actions.newLinkAction(null, linkForm);
    expect(relinked?.ok).toBe(true);
    expect(await findPersonByToken(db, samOld)).toBeNull();

    const removeSelf = new FormData();
    removeSelf.set("person_id", chris.id);
    await actions.removePersonAction(removeSelf);
    const removeSam = new FormData();
    removeSam.set("person_id", sam.id);
    await actions.removePersonAction(removeSam);
    expect((await listPeople(db)).map((p) => p.name)).toEqual(["Chris"]);
  });
});

describe("joining and leaving", () => {
  it("a valid invite token signs this browser in and lands on the board", async () => {
    const { token } = await createPerson(db, { name: "Sam" });
    expect(await redirectOf(() => actions.joinAction(token))).toBe("/jobs");
    expect(cookieJar[PERSON_COOKIE]).toBe(token);
    expect((await listPeople(db))[0].last_seen_at).not.toBeNull();
  });

  it("a dead token signs nobody in", async () => {
    const result = await actions.joinAction("nope");
    expect(result.ok).toBe(false);
    expect(cookieJar[PERSON_COOKIE]).toBeUndefined();
  });

  it("signing out forgets the cookie", async () => {
    const { token } = await createPerson(db, { name: "Sam" });
    signInAs(token);
    expect(await redirectOf(() => actions.signOutAction())).toBe("/");
    expect(cookieJar[PERSON_COOKIE]).toBeUndefined();
  });

  it("invite links point at /join# on this host", async () => {
    const { token: owner } = await createPerson(db, { name: "Chris", isOwner: true });
    signInAs(owner);
    const form = new FormData();
    form.set("name", "Jordan");
    const added = await actions.addPersonAction(null, form);
    if (!added?.ok) throw new Error("expected a link");
    expect(added.link).toMatch(/^https:\/\/board\.test\/join#[A-Za-z0-9_-]{32}$/);
  });

  it("a new link for the owner's own row keeps them signed in", async () => {
    const { person, token } = await createPerson(db, { name: "Chris", isOwner: true });
    signInAs(token);
    const form = new FormData();
    form.set("person_id", person.id);
    form.set("name", person.name);
    const result = await actions.newLinkAction(null, form);
    expect(result?.ok).toBe(true);
    expect(cookieJar[PERSON_COOKIE]).not.toBe(token);
    expect((await findPersonByToken(db, cookieJar[PERSON_COOKIE]))?.id).toBe(person.id);
  });

  it("removal ignores malformed ids and other owners", async () => {
    const { token } = await createPerson(db, { name: "Chris", isOwner: true });
    const { person: other } = await createPerson(db, { name: "Pat", isOwner: true });
    signInAs(token);
    for (const id of ["not-a-uuid", other.id]) {
      const form = new FormData();
      form.set("person_id", id);
      await actions.removePersonAction(form);
    }
    expect(await listPeople(db)).toHaveLength(2);
  });
});

describe("safeDescription", () => {
  it("drops scripts, handlers, iframes and javascript: links but keeps formatting", () => {
    const out = safeDescription(
      '<p onclick="x()">Hi <strong>there</strong></p><script>alert(1)</script>' +
        '<img src=x onerror=alert(1)><iframe src="https://evil.test"></iframe>' +
        '<a href="javascript:alert(1)">bad</a><a href="https://ok.test">ok</a>',
    );
    expect(out).toContain("<p>Hi <strong>there</strong></p>");
    expect(out).not.toMatch(/script|onerror|onclick|iframe|<img|javascript:/i);
    expect(out).toContain('href="https://ok.test"');
  });

  it("decodes entity-escaped HTML, then still sanitizes it", () => {
    const out = safeDescription("&lt;h2&gt;About&lt;/h2&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).toContain("<h2>About</h2>");
    expect(out).not.toMatch(/script/i);
  });

  it("leaves plain text alone", () => {
    expect(safeDescription("Remote (US) | $150k & equity")).toBe("Remote (US) | $150k &amp; equity");
  });
});

describe("movesFor", () => {
  it("offers exactly the moves PERSONAL_TRANSITIONS allows", () => {
    const offered: Array<[string, PersonStatus]> = [];
    for (const from of [null, "queued", "applied", "dismissed"] as const) {
      for (const move of movesFor(from)) {
        expect(isAllowedPersonalTransition(from, move.to)).toBe(true);
        offered.push([from ?? "new", move.to]);
      }
    }
    expect(offered.sort()).toEqual([...PERSONAL_TRANSITIONS].map((t) => [...t]).sort());
  });
});
