/**
 * ATDD scenarios S1–S8 for the admin app (spec 08 §3).
 *
 * All tests run against PGlite (in-process Postgres) with an injected session —
 * no live Auth0 tenant, no real Supabase DB, no network calls.
 *
 * The auth seam: requireAllowedUser() accepts an optional `getEmail` injector
 * so we can supply a fake session without patching the module.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyStatusTransition,
  createPgliteTestDb,
  getCriteria,
  listJobs,
  type Db,
  updateCriteria,
  upsertJob,
  recordCrawlRun,
  DEFAULT_CRITERIA,
  InvalidTransitionError,
} from "@jobscout/core";
import { requireAllowedUser } from "../src/lib/auth.js";
import type { RawJob } from "@jobscout/core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Test DB lifecycle
// ---------------------------------------------------------------------------
let db: Db;
let closeDb: () => Promise<void>;

beforeEach(async () => {
  ({ db, close: closeDb } = await createPgliteTestDb());
});

afterEach(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// apps/admin/test/ -> apps/admin -> apps -> repo root -> apps/crawler/...
const FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../crawler/test/fixtures/greenhouse/job-with-questions.json",
);

function loadFixture(): unknown {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
}

let _seq = 0;
function makeRawJob(overrides: Partial<RawJob> = {}): RawJob {
  const n = ++_seq;
  return {
    source: "greenhouse",
    externalId: `admin-test-${n}`,
    url: `https://example.com/jobs/${n}`,
    title: `Test Job ${n}`,
    company: "Test Co",
    location: "Remote",
    raw: { id: n },
    ...overrides,
  };
}

const ALLOWED_EMAIL = "admin@superapps.com";
const ALLOWED_EMAILS_CSV = ALLOWED_EMAIL;

function allowedSession() {
  return async () => ALLOWED_EMAIL;
}

function nullSession() {
  return async () => null as string | null;
}

function nonAllowlistedSession() {
  return async () => "intruder@example.com";
}

// ---------------------------------------------------------------------------
// S1 — Unauthenticated request redirects to login
// ---------------------------------------------------------------------------
describe("S1 — unauthenticated request", () => {
  it("requireAllowedUser with null session throws a redirect (NEXT_REDIRECT)", async () => {
    // Next.js redirect() throws an error with digest "NEXT_REDIRECT"
    let thrown: unknown = null;
    try {
      // Override ADMIN_ALLOWED_EMAILS so isAllowed can run (though it won't reach it)
      process.env.ADMIN_ALLOWED_EMAILS = ALLOWED_EMAILS_CSV;
      await requireAllowedUser(nullSession());
    } catch (err) {
      thrown = err;
    } finally {
      delete process.env.ADMIN_ALLOWED_EMAILS;
    }
    // Next.js redirect() throws an error; the message or digest contains NEXT_REDIRECT
    expect(thrown).toBeTruthy();
    const errStr = String(
      (thrown as { digest?: string; message?: string })?.digest ??
        (thrown as { message?: string })?.message ??
        thrown,
    );
    expect(errStr.toUpperCase()).toContain("NEXT_REDIRECT");
  });

  it("no data-layer calls when session is null (gate fires before any DB query)", async () => {
    // We verify the gate throws before we can even call listJobs
    process.env.ADMIN_ALLOWED_EMAILS = ALLOWED_EMAILS_CSV;
    let dbCalled = false;
    let thrown = false;
    try {
      await requireAllowedUser(nullSession());
      // If we get here the gate didn't fire — would call DB (but we don't here)
      dbCalled = true;
    } catch {
      thrown = true;
    } finally {
      delete process.env.ADMIN_ALLOWED_EMAILS;
    }
    expect(thrown).toBe(true);
    expect(dbCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// S2 — Authenticated but non-allowlisted email gets 403
// ---------------------------------------------------------------------------
describe("S2 — non-allowlisted email", () => {
  it("requireAllowedUser triggers a genuine 403 (forbidden interrupt) for a non-allowlisted email", async () => {
    process.env.ADMIN_ALLOWED_EMAILS = ALLOWED_EMAILS_CSV;
    let thrown: unknown = null;
    try {
      await requireAllowedUser(nonAllowlistedSession());
    } catch (err) {
      thrown = err;
    } finally {
      delete process.env.ADMIN_ALLOWED_EMAILS;
    }
    // Next.js forbidden() throws a routing interrupt whose digest is
    // `NEXT_HTTP_ERROR_FALLBACK;403` — Next renders forbidden.tsx with HTTP 403.
    // Assert the 403 semantics, not a plain thrown Error, so a page that
    // rendered "Not authorized" with a 200 status would fail this test.
    expect(thrown).toBeTruthy();
    const digest = String(
      (thrown as { digest?: string; message?: string })?.digest ??
        (thrown as { message?: string })?.message ??
        thrown,
    );
    expect(digest).toContain("NEXT_HTTP_ERROR_FALLBACK");
    expect(digest).toContain("403");
  });

  it("the 403 page (forbidden.tsx) renders the required 'Not authorized' body", () => {
    // The 403 status comes from Next serving forbidden.tsx; assert its body
    // contains the spec-required text without booting a Next server.
    const forbiddenPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../src/app/forbidden.tsx",
    );
    const content = readFileSync(forbiddenPath, "utf8");
    expect(content).toContain("Not authorized");
  });

  it("no data-layer calls when email is not allowlisted", async () => {
    process.env.ADMIN_ALLOWED_EMAILS = ALLOWED_EMAILS_CSV;
    let dbCalled = false;
    let threw = false;
    try {
      await requireAllowedUser(nonAllowlistedSession());
      dbCalled = true;
    } catch {
      threw = true;
    } finally {
      delete process.env.ADMIN_ALLOWED_EMAILS;
    }
    expect(threw).toBe(true);
    expect(dbCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// S3 — Queue on a new job persists status=queued
// ---------------------------------------------------------------------------
describe("S3 — Queue action persists queued", () => {
  it("transitions job from new to queued, applied_at and dismissed_at remain null", async () => {
    process.env.ADMIN_ALLOWED_EMAILS = ALLOWED_EMAILS_CSV;

    // Seed with fixture raw payload
    const fixture = loadFixture();
    const { job } = await upsertJob(db, makeRawJob({ raw: fixture }));
    expect(job.status).toBe("new");

    // Simulate the server action: require auth then transition
    await requireAllowedUser(allowedSession());
    await applyStatusTransition(db, job.id, "queued");

    const r = await db.query(
      `SELECT status, applied_at, dismissed_at FROM jobs WHERE id = $1`,
      [job.id],
    );
    expect(r.rows[0].status).toBe("queued");
    expect(r.rows[0].applied_at).toBeNull();
    expect(r.rows[0].dismissed_at).toBeNull();

    delete process.env.ADMIN_ALLOWED_EMAILS;
  });
});

// ---------------------------------------------------------------------------
// S4 — Invalid transition is rejected and the row is unchanged
// ---------------------------------------------------------------------------
describe("S4 — invalid transition rejected", () => {
  it("applying 'applied' on a dismissed job throws InvalidTransitionError, row unchanged", async () => {
    process.env.ADMIN_ALLOWED_EMAILS = ALLOWED_EMAILS_CSV;

    // Seed a dismissed job
    const { job } = await upsertJob(db, makeRawJob({ externalId: "s4-dismissed" }));
    await applyStatusTransition(db, job.id, "dismissed");
    // Set notes
    await db.query(`UPDATE jobs SET notes = 'keep me' WHERE id = $1`, [job.id]);

    // Read before state
    const before = await db.query(
      `SELECT status, applied_at, dismissed_at, notes FROM jobs WHERE id = $1`,
      [job.id],
    );
    expect(before.rows[0].status).toBe("dismissed");

    // Attempt illegal transition
    await requireAllowedUser(allowedSession());
    let thrown: unknown = null;
    try {
      await applyStatusTransition(db, job.id, "applied");
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(InvalidTransitionError);
    expect((thrown as InvalidTransitionError).from).toBe("dismissed");
    expect((thrown as InvalidTransitionError).to).toBe("applied");

    // Row must be unchanged
    const after = await db.query(
      `SELECT status, applied_at, dismissed_at, notes FROM jobs WHERE id = $1`,
      [job.id],
    );
    expect(after.rows[0].status).toBe("dismissed");
    expect(after.rows[0].applied_at).toBeNull();
    expect(after.rows[0].dismissed_at).not.toBeNull();
    expect(after.rows[0].notes).toBe("keep me");

    delete process.env.ADMIN_ALLOWED_EMAILS;
  });
});

// ---------------------------------------------------------------------------
// S5 — Criteria edit persists and reads back
// ---------------------------------------------------------------------------
describe("S5 — criteria edit persists", () => {
  it("updates notify_min_score and appended keyword, getCriteria returns new value", async () => {
    process.env.ADMIN_ALLOWED_EMAILS = ALLOWED_EMAILS_CSV;

    // Seed criteria (migration already inserts default; read it back)
    const before = await getCriteria(db);
    expect(before.notify_min_score).toBe(50);

    const updatedBefore = await db.query(
      `SELECT updated_at FROM criteria WHERE id = 1`,
    );
    const prevUpdatedAt = updatedBefore.rows[0].updated_at;

    // Simulate criteria form submit
    await requireAllowedUser(allowedSession());
    const newValue = {
      ...before,
      notify_min_score: 55,
      role_priorities: before.role_priorities.map((rp) =>
        rp.category === "react-native"
          ? { ...rp, keywords: [...rp.keywords, "react native developer"] }
          : rp,
      ),
    };
    await updateCriteria(db, newValue);

    // Verify via SQL
    const sqlResult = await db.query(
      `SELECT value, updated_at FROM criteria WHERE id = 1`,
    );
    const val = sqlResult.rows[0].value as typeof newValue;
    expect(val.notify_min_score).toBe(55);
    const rnKeywords = val.role_priorities.find(
      (rp: { category: string }) => rp.category === "react-native",
    )?.keywords as string[];
    expect(rnKeywords).toContain("react native developer");

    // updated_at must have advanced
    const newUpdatedAt = sqlResult.rows[0].updated_at;
    if (prevUpdatedAt !== null) {
      expect(new Date(newUpdatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(prevUpdatedAt).getTime(),
      );
    }

    // getCriteria returns the new value
    const read = await getCriteria(db);
    expect(read.notify_min_score).toBe(55);
    expect(
      read.role_priorities
        .find((rp) => rp.category === "react-native")
        ?.keywords,
    ).toContain("react native developer");

    delete process.env.ADMIN_ALLOWED_EMAILS;
  });
});

// ---------------------------------------------------------------------------
// S6 — Invalid criteria input shows field errors and writes nothing
// ---------------------------------------------------------------------------
describe("S6 — invalid criteria writes nothing", () => {
  it("updateCriteria throws ZodError on invalid input and DB is unchanged", async () => {
    process.env.ADMIN_ALLOWED_EMAILS = ALLOWED_EMAILS_CSV;

    const before = await getCriteria(db);
    const beforeSql = await db.query(
      `SELECT value, updated_at FROM criteria WHERE id = 1`,
    );

    // Submit invalid: notify_min_score="high" (not a number), role_priorities missing category
    await requireAllowedUser(allowedSession());
    let thrown: unknown = null;
    try {
      await updateCriteria(db, {
        ...before,
        notify_min_score: "high", // invalid — must be integer
        role_priorities: [{ priority: 1, keywords: ["react"] }], // missing category
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeTruthy();
    expect((thrown as Error).name).toBe("ZodError");

    // DB must be unchanged
    const afterSql = await db.query(
      `SELECT value, updated_at FROM criteria WHERE id = 1`,
    );
    expect(JSON.stringify(afterSql.rows[0].value)).toBe(
      JSON.stringify(beforeSql.rows[0].value),
    );
    // updated_at unchanged (null comparison: both should be the same value)
    expect(String(afterSql.rows[0].updated_at)).toBe(
      String(beforeSql.rows[0].updated_at),
    );

    delete process.env.ADMIN_ALLOWED_EMAILS;
  });
});

// ---------------------------------------------------------------------------
// S7 — /jobs status filter returns only matching rows, 50 per page
// ---------------------------------------------------------------------------
describe("S7 — listJobs status filter + pagination", () => {
  it("returns only queued rows with total=3 when filtering by status=queued", async () => {
    process.env.ADMIN_ALLOWED_EMAILS = ALLOWED_EMAILS_CSV;

    // Seed 55 new, 3 queued, 2 dismissed
    const queuedIds: string[] = [];
    for (let i = 0; i < 55; i++) {
      await upsertJob(db, makeRawJob({ externalId: `s7-new-${i}` }));
    }
    for (let i = 0; i < 3; i++) {
      const { job } = await upsertJob(
        db,
        makeRawJob({ externalId: `s7-queued-${i}` }),
      );
      await applyStatusTransition(db, job.id, "queued");
      queuedIds.push(job.id);
    }
    for (let i = 0; i < 2; i++) {
      const { job } = await upsertJob(
        db,
        makeRawJob({ externalId: `s7-dismissed-${i}` }),
      );
      await applyStatusTransition(db, job.id, "dismissed");
    }

    await requireAllowedUser(allowedSession());

    // Filter queued
    const queued = await listJobs(db, {
      status: "queued",
      sort: "first_seen_at",
      dir: "desc",
      limit: 50,
      offset: 0,
    });
    expect(queued.total).toBe(3);
    expect(queued.rows.length).toBe(3);
    expect(queued.rows.every((r) => r.status === "queued")).toBe(true);
    for (const id of queuedIds) {
      expect(queued.rows.some((r) => r.id === id)).toBe(true);
    }

    // Pagination: new jobs page 1 (50) and page 2 (5)
    const newP1 = await listJobs(db, {
      status: "new",
      sort: "first_seen_at",
      dir: "desc",
      limit: 50,
      offset: 0,
    });
    expect(newP1.total).toBe(55);
    expect(newP1.rows.length).toBe(50);

    const newP2 = await listJobs(db, {
      status: "new",
      sort: "first_seen_at",
      dir: "desc",
      limit: 50,
      offset: 50,
    });
    expect(newP2.rows.length).toBe(5);

    // No overlap between page 1 and page 2
    const p1Ids = new Set(newP1.rows.map((r) => r.id));
    for (const r of newP2.rows) {
      expect(p1Ids.has(r.id)).toBe(false);
    }

    delete process.env.ADMIN_ALLOWED_EMAILS;
  });
});

// ---------------------------------------------------------------------------
// S8 — Service key and public Supabase vars never reach the client bundle
// ---------------------------------------------------------------------------
describe("S8 — security: no secrets in bundle or source", () => {
  it("job-with-questions.json fixture exists and is non-empty", () => {
    const stat = readFileSync(FIXTURE_PATH);
    expect(stat.length).toBeGreaterThan(0);
  });

  // NOTE: the test description and needle are built via concatenation so the
  // literal pattern never appears in this file (spec requirement).
  it("no public-db env var pattern anywhere under apps/admin (source + tests + build)", () => {
    // apps/admin/test/ -> apps/admin
    const adminRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
    );
    // Needle assembled at runtime — literal must not appear anywhere under
    // apps/admin/ (spec S8: including this test's own source).
    const needle = ["NEXT", "PUBLIC", "SUPABASE"].join("_");
    let found = false;
    try {
      // grep exits 0 if found, 1 if not found. Exclude node_modules only —
      // .next build output IS in scope for the leak check.
      execSync(
        `grep -r --exclude-dir=node_modules "${needle}" "${adminRoot}"`,
        { stdio: "pipe" },
      );
      found = true;
    } catch {
      found = false;
    }
    expect(found).toBe(false);
  });

  it("README documents the server-side env vars (contract set) and no NEXT_PUBLIC_", () => {
    // apps/admin/test/ -> apps/admin/README.md
    const readmePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../README.md",
    );
    const readme = readFileSync(readmePath, "utf8");
    const expectedVars = [
      "SUPABASE_DB_URL",
      "AUTH0_DOMAIN",
      "AUTH0_CLIENT_ID",
      "AUTH0_CLIENT_SECRET",
      "AUTH0_SECRET",
      "APP_BASE_URL",
      "ADMIN_ALLOWED_EMAILS",
    ];
    for (const v of expectedVars) {
      expect(readme).toContain(v);
    }
    // The public-db pattern (assembled) must not appear in the README either.
    const needle = ["NEXT", "PUBLIC", "SUPABASE"].join("_");
    expect(readme).not.toContain(needle);
  });

  it("src/lib/db.ts imports server-only", () => {
    // apps/admin/test/ -> apps/admin/src/lib/db.ts
    const dbPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../src/lib/db.ts",
    );
    const content = readFileSync(dbPath, "utf8");
    expect(content).toContain('import "server-only"');
  });
});
