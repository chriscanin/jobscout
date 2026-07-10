import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyStatusTransition,
  expireStaleJobs,
  getCriteria,
  incrementMissingStreakForMissing,
  markNotified,
  recordCrawlRun,
  syncSeedCompanies,
  updateCriteria,
  upsertJob,
} from "../src/data.js";
import { createPgliteTestDb, type Db } from "../src/db.js";
import { dedupHash } from "../src/dedup.js";
import { DEFAULT_CRITERIA, type RawJob, type SeedCompany } from "../src/schemas.js";
import { InvalidTransitionError } from "../src/status.js";
import type { Status } from "../src/enums.js";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createPgliteTestDb());
});

afterEach(async () => {
  await close();
});

/** A Normalized/RawJob built from the Mattermost Greenhouse fixture. */
function mattermostJob(overrides: Partial<RawJob> = {}): RawJob {
  return {
    source: "greenhouse",
    externalId: "5238290008",
    url: "https://job-boards.greenhouse.io/mattermost/jobs/5238290008",
    title: "Senior Software Engineer",
    company: "Mattermost, Inc.",
    location: "United States",
    atsHint: "greenhouse",
    raw: { id: 5238290008 },
    ...overrides,
  };
}

async function getJob(id: string): Promise<any> {
  const r = await db.query(`select * from jobs where id = $1`, [id]);
  return r.rows[0];
}

// ---------------------------------------------------------------------------
// Scenario 1 — Fresh migrations apply cleanly on an empty database
// ---------------------------------------------------------------------------
describe("Scenario 1 — migrations apply cleanly", () => {
  it("creates the four tables", async () => {
    const r = await db.query(
      `select table_name from information_schema.tables
       where table_schema = 'public'
         and table_name in ('jobs','companies','crawl_runs','criteria')
       order by table_name`,
    );
    expect(r.rows.map((x) => x.table_name)).toEqual([
      "companies",
      "crawl_runs",
      "criteria",
      "jobs",
    ]);
  });

  it("has a unique index on jobs (source, external_id) and companies (ats, board_token), and an index on jobs (dedup_hash)", async () => {
    const r = await db.query(
      `select indexname, indexdef from pg_indexes where schemaname = 'public'`,
    );
    const defs = r.rows.map((x) => x.indexdef as string);
    const hasUniqueJobsSourceExt = defs.some(
      (d) =>
        /unique/i.test(d) &&
        /on public\.jobs/i.test(d) &&
        /source/.test(d) &&
        /external_id/.test(d),
    );
    const hasUniqueCompanies = defs.some(
      (d) =>
        /unique/i.test(d) &&
        /on public\.companies/i.test(d) &&
        /ats/.test(d) &&
        /board_token/.test(d),
    );
    const hasDedupIdx = defs.some(
      (d) => /on public\.jobs/i.test(d) && /dedup_hash/.test(d),
    );
    expect(hasUniqueJobsSourceExt).toBe(true);
    expect(hasUniqueCompanies).toBe(true);
    expect(hasDedupIdx).toBe(true);
  });

  it("seeds criteria id=1 deep-equal to the contract default", async () => {
    const r = await db.query(`select value from criteria where id = 1`);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].value).toEqual(DEFAULT_CRITERIA);
  });

  it("rejects invalid enum values with CHECK violation 23514", async () => {
    const insertBad = (col: string, val: string) =>
      db.query(
        `insert into jobs (source, external_id, url, title, company, dedup_hash, ${col})
         values ('greenhouse', 'x', 'u', 't', 'c', 'h', $1)`,
        [val],
      );
    await expect(insertBad("status", "bogus")).rejects.toMatchObject({
      code: "23514",
    });
    await expect(
      db.query(
        `insert into jobs (source, external_id, url, title, company, dedup_hash)
         values ('monster', 'y', 'u', 't', 'c', 'h')`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.query(
        `insert into crawl_runs (trigger) values ('cron')`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — Upsert of a brand-new job
// ---------------------------------------------------------------------------
describe("Scenario 2 — upsert a brand-new job", () => {
  it("inserts with status new, streak 0, ats greenhouse, first==last, correct dedup_hash", async () => {
    const job = mattermostJob();
    const { job: row, isNew } = await upsertJob(db, job);
    expect(isNew).toBe(true);
    expect(row.status).toBe("new");
    expect(row.missing_streak).toBe(0);
    expect(row.difficulty).toBe("unknown");
    expect(row.ats).toBe("greenhouse");
    expect(new Date(row.first_seen_at).getTime()).toBe(
      new Date(row.last_seen_at).getTime(),
    );
    expect(row.dedup_hash).toBe(
      dedupHash(job.company, job.title, job.location ?? null),
    );
  });

  it("defaults ats to unknown when atsHint is absent", async () => {
    const { job } = await upsertJob(
      db,
      mattermostJob({ atsHint: undefined, externalId: "no-hint" }),
    );
    expect(job.ats).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — Re-upsert of a seen job never regresses user state
// ---------------------------------------------------------------------------
describe("Scenario 3 — re-upsert never regresses user state", () => {
  it("advances last_seen_at, resets streak, updates title, preserves status/notes/first_seen_at", async () => {
    const { job: first } = await upsertJob(db, mattermostJob());
    const id = first.id;

    // move to queued (new -> queued), set notes, bump missing_streak to 1
    await applyStatusTransition(db, id, "queued");
    await db.query(`update jobs set notes = 'call back' where id = $1`, [id]);
    await incrementMissingStreakForMissing(db, "greenhouse", []);

    const before = await getJob(id);
    expect(before.status).toBe("queued");
    expect(before.missing_streak).toBe(1);

    // ensure clock advances measurably
    await new Promise((r) => setTimeout(r, 5));

    const { job: second, isNew } = await upsertJob(
      db,
      mattermostJob({ title: "Staff Software Engineer" }),
    );
    expect(isNew).toBe(false);
    expect(second.title).toBe("Staff Software Engineer");
    expect(second.missing_streak).toBe(0);
    expect(second.status).toBe("queued");
    expect(second.notes).toBe("call back");
    expect(new Date(second.first_seen_at).getTime()).toBe(
      new Date(before.first_seen_at).getTime(),
    );
    expect(new Date(second.last_seen_at).getTime()).toBeGreaterThan(
      new Date(before.last_seen_at).getTime(),
    );

    const count = await db.query(`select count(*)::int as n from jobs`);
    expect(count.rows[0].n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — Status machine: invalid transitions throw
// ---------------------------------------------------------------------------
describe("Scenario 4 — status machine enforcement", () => {
  const ALL_STATUSES: Status[] = [
    "new",
    "notified",
    "queued",
    "applied",
    "dismissed",
    "expired",
  ];
  const LEGAL = new Set([
    "new->notified",
    "new->queued",
    "new->dismissed",
    "notified->queued",
    "notified->dismissed",
    "queued->applied",
    "queued->dismissed",
    "applied->queued",
    "dismissed->queued",
    "new->expired",
    "notified->expired",
  ]);

  /** Create a job forced into a given status. */
  async function jobInStatus(externalId: string, status: Status): Promise<string> {
    const { job } = await upsertJob(db, mattermostJob({ externalId }));
    await db.query(`update jobs set status = $2 where id = $1`, [job.id, status]);
    return job.id;
  }

  it("accepts exactly the 11 legal pairs and rejects the other 25 (incl. self-transitions)", async () => {
    let legalPassed = 0;
    let illegalRejected = 0;
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const key = `${from}->${to}`;
        const id = await jobInStatus(`job-${from}-${to}`, from);
        if (LEGAL.has(key)) {
          const row = await applyStatusTransition(db, id, to);
          expect(row.status).toBe(to);
          legalPassed += 1;
        } else {
          await expect(applyStatusTransition(db, id, to)).rejects.toBeInstanceOf(
            InvalidTransitionError,
          );
          const row = await getJob(id);
          expect(row.status).toBe(from); // unchanged
          illegalRejected += 1;
        }
      }
    }
    expect(legalPassed).toBe(11);
    expect(illegalRejected).toBe(25);
  });

  it("markNotified stamps notified_at once and rejects a second call", async () => {
    const { job } = await upsertJob(db, mattermostJob());
    const notified = await markNotified(db, job.id);
    expect(notified.status).toBe("notified");
    expect(notified.notified_at).not.toBeNull();
    const stamp = new Date(notified.notified_at!).getTime();

    await expect(markNotified(db, job.id)).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
    const after = await getJob(job.id);
    expect(new Date(after.notified_at).getTime()).toBe(stamp); // unchanged
  });

  it("stamps applied_at and dismissed_at on entry", async () => {
    const { job } = await upsertJob(db, mattermostJob());
    await applyStatusTransition(db, job.id, "queued");
    const applied = await applyStatusTransition(db, job.id, "applied");
    expect(applied.applied_at).not.toBeNull();

    const { job: job2 } = await upsertJob(
      db,
      mattermostJob({ externalId: "dismissed-one" }),
    );
    const dismissed = await applyStatusTransition(db, job2.id, "dismissed");
    expect(dismissed.dismissed_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — Expiry only hits new/notified with missing_streak >= 2
// ---------------------------------------------------------------------------
describe("Scenario 5 — expiry", () => {
  async function seedJob(
    externalId: string,
    status: Status,
    streak: number,
  ): Promise<string> {
    const { job } = await upsertJob(db, mattermostJob({ externalId }));
    await db.query(
      `update jobs set status = $2, missing_streak = $3 where id = $1`,
      [job.id, status, streak],
    );
    return job.id;
  }

  it("expires only new/notified with streak >= 2, leaves the rest untouched", async () => {
    const idNew2 = await seedJob("j1", "new", 2);
    const idNotified3 = await seedJob("j2", "notified", 3);
    const idNew1 = await seedJob("j3", "new", 1);
    const idQueued5 = await seedJob("j4", "queued", 5);
    const idApplied4 = await seedJob("j5", "applied", 4);
    const idDismissed2 = await seedJob("j6", "dismissed", 2);

    const expired = await expireStaleJobs(db);
    expect(expired).toBe(2);

    expect((await getJob(idNew2)).status).toBe("expired");
    expect((await getJob(idNotified3)).status).toBe("expired");

    const untouched = [
      [idNew1, "new", 1],
      [idQueued5, "queued", 5],
      [idApplied4, "applied", 4],
      [idDismissed2, "dismissed", 2],
    ] as const;
    for (const [id, status, streak] of untouched) {
      const row = await getJob(id);
      expect(row.status).toBe(status);
      expect(row.missing_streak).toBe(streak);
    }

    // expired rows are skipped by a subsequent missing-streak increment
    const streakBeforeNew2 = (await getJob(idNew2)).missing_streak;
    const streakBeforeNotified3 = (await getJob(idNotified3)).missing_streak;
    await incrementMissingStreakForMissing(db, "greenhouse", []);
    expect((await getJob(idNew2)).missing_streak).toBe(streakBeforeNew2);
    expect((await getJob(idNotified3)).missing_streak).toBe(
      streakBeforeNotified3,
    );
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — dedup_hash normalization
// ---------------------------------------------------------------------------
describe("Scenario 6 — dedup_hash normalization", () => {
  it("normalizes punctuation/case/whitespace and null==empty location", () => {
    expect(
      dedupHash("Mattermost, Inc.", "Senior  Software Engineer!", null),
    ).toBe(dedupHash("mattermost inc", "senior software engineer", ""));
    expect(dedupHash("A", "B", null)).toBe(dedupHash("A", "B", ""));
    expect(dedupHash("Acme", "Engineer", "Remote")).not.toBe(
      dedupHash("Acme", "Engineer", null),
    );
    for (const h of [
      dedupHash("Mattermost, Inc.", "X", null),
      dedupHash("A", "B", "C"),
    ]) {
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 7 — Criteria roundtrip; malformed value rejected, nothing written
// ---------------------------------------------------------------------------
describe("Scenario 7 — criteria roundtrip and validation", () => {
  it("rejects malformed criteria without writing, then accepts a valid update", async () => {
    const original = await getCriteria(db);
    expect(original).toEqual(DEFAULT_CRITERIA);

    const before = await db.query(
      `select updated_at from criteria where id = 1`,
    );

    await expect(
      updateCriteria(db, { ...DEFAULT_CRITERIA, notify_min_score: "sixty" }),
    ).rejects.toThrow();

    // nothing written: value + updated_at unchanged
    expect(await getCriteria(db)).toEqual(DEFAULT_CRITERIA);
    const afterBad = await db.query(
      `select updated_at from criteria where id = 1`,
    );
    expect(afterBad.rows[0].updated_at).toEqual(before.rows[0].updated_at);

    await new Promise((r) => setTimeout(r, 5));
    const updated = await updateCriteria(db, {
      ...DEFAULT_CRITERIA,
      notify_min_score: 40,
    });
    expect(updated.notify_min_score).toBe(40);
    expect((await getCriteria(db)).notify_min_score).toBe(40);

    const afterGood = await db.query(
      `select updated_at from criteria where id = 1`,
    );
    expect(new Date(afterGood.rows[0].updated_at).getTime()).toBeGreaterThan(
      new Date(before.rows[0].updated_at).getTime(),
    );
  });
});

// ---------------------------------------------------------------------------
// Scenario 8 — syncSeedCompanies idempotency + preserves active; crawl runs
// ---------------------------------------------------------------------------
describe("Scenario 8 — seed companies + crawl runs", () => {
  const seed: SeedCompany[] = [
    {
      name: "Mattermost",
      ats: "greenhouse",
      boardToken: "mattermost",
      careersUrl: "https://mattermost.com/careers/",
    },
    {
      name: "Airbyte",
      ats: "greenhouse",
      boardToken: "airbyte",
      careersUrl: "https://airbyte.com/careers",
    },
  ];

  it("is idempotent, preserves active=false, and persists changed careers_url", async () => {
    const first = await syncSeedCompanies(db, seed);
    expect(first).toEqual({ inserted: 2, updated: 0 });

    const rows = await db.query(
      `select name, discovered_via, active from companies order by name`,
    );
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) {
      expect(row.discovered_via).toBe("seed");
      expect(row.active).toBe(true);
    }

    // deactivate Airbyte, then re-run with a changed careersUrl for it
    await db.query(
      `update companies set active = false where board_token = 'airbyte'`,
    );
    const changedSeed: SeedCompany[] = seed.map((c) =>
      c.boardToken === "airbyte"
        ? { ...c, careersUrl: "https://airbyte.com/jobs" }
        : c,
    );
    const second = await syncSeedCompanies(db, changedSeed);
    expect(second).toEqual({ inserted: 0, updated: 2 });

    const count = await db.query(`select count(*)::int as n from companies`);
    expect(count.rows[0].n).toBe(2);

    const airbyte = await db.query(
      `select careers_url, active from companies where board_token = 'airbyte'`,
    );
    expect(airbyte.rows[0].careers_url).toBe("https://airbyte.com/jobs");
    expect(airbyte.rows[0].active).toBe(false);
  });

  it("records a crawl run with stats roundtripping as JSON", async () => {
    const stats = {
      greenhouse: { fetched: 10, new: 3, updated: 7, errors: [] as string[] },
      lever: { fetched: 5, new: 0, updated: 4, errors: ["timeout"] },
    };
    const run = await recordCrawlRun(db, {
      startedAt: "2026-07-09T00:00:00.000Z",
      finishedAt: "2026-07-09T00:01:00.000Z",
      trigger: "manual",
      stats,
      notifiedCount: 0,
      ok: true,
    });
    expect(run.trigger).toBe("manual");
    expect(run.notified_count).toBe(0);
    expect(run.ok).toBe(true);
    expect(run.stats).toEqual(stats);

    const stored = await db.query(
      `select stats from crawl_runs where id = $1`,
      [run.id],
    );
    expect(stored.rows[0].stats).toEqual(stats);
  });
});
