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
 * Split a SQL script into individual statements. PGlite's `query` (unlike node
 * `pg`) rejects multiple commands in one call, so migrations are executed
 * statement-by-statement. This is a lightweight splitter that respects single
 * quotes and `--` line comments — sufficient for our hand-written migrations.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inLineComment = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (inLineComment) {
      current += ch;
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (!inSingleQuote && ch === "-" && next === "-") {
      inLineComment = true;
      current += ch;
      continue;
    }
    if (ch === "'") {
      inSingleQuote = !inSingleQuote;
      current += ch;
      continue;
    }
    if (ch === ";" && !inSingleQuote) {
      if (current.trim().length > 0) statements.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) statements.push(current.trim());
  return statements;
}

/**
 * Apply every `.sql` file in `dir` to `db` in filename order, executing each
 * file statement-by-statement (PGlite rejects multi-command queries). Missing
 * directory is treated as "no migrations".
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
    for (const statement of splitSqlStatements(sql)) {
      await db.query(statement);
    }
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
