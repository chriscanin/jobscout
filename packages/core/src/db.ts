import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

/**
 * The single DB abstraction (CONTRACT §Stack). One method, `query`, satisfied
 * by both `pg.Pool` (production, from `SUPABASE_DB_URL`) and PGlite (tests).
 */
export interface Db {
  query(text: string, params?: any[]): Promise<{ rows: any[] }>;
}

/** Production `Db` backed by a pg connection pool. */
export function createPgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString });
  return {
    async query(text: string, params?: any[]) {
      const result = await pool.query(text, params);
      return { rows: result.rows };
    },
  };
}

/**
 * Apply every `.sql` file in `dir` to `db` in filename order. In wave 0 there
 * are zero migration files, so this applies nothing. Missing directory is
 * treated as "no migrations".
 */
export async function applyMigrations(db: Db, dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  const files = entries.filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = await readFile(path.join(dir, file), "utf8");
    if (sql.trim().length === 0) continue;
    await db.query(sql);
  }
}

/** Absolute path to the repo's `supabase/migrations` directory. */
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../supabase/migrations",
);

/**
 * Spin up an in-process PGlite database and apply every migration to it. In
 * wave 0 there are no migration files, so it returns an empty DB. Returns the
 * `Db` plus a `close` to release the instance.
 */
export async function createPgliteTestDb(): Promise<{
  db: Db;
  close: () => Promise<void>;
}> {
  const client = new PGlite();
  const db: Db = {
    async query(text: string, params?: any[]) {
      const result = await client.query(text, params ?? []);
      return { rows: result.rows as any[] };
    },
  };
  await applyMigrations(db, MIGRATIONS_DIR);
  return {
    db,
    close: async () => {
      await client.close();
    },
  };
}
