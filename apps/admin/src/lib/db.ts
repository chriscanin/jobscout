import "server-only";
import { createPgDb, type Db } from "@jobscout/core";

let _db: Db | null = null;

/**
 * Lazily create and cache a pg-backed Db from SUPABASE_DB_URL.
 * Server-only: the `import "server-only"` guard prevents this from being
 * bundled into any client component. No NEXT_PUBLIC_ vars are used.
 */
export function getDb(): Db {
  if (_db) return _db;
  const url = process.env.SUPABASE_DB_URL;
  if (!url) {
    throw new Error("SUPABASE_DB_URL is not set");
  }
  _db = createPgDb(url);
  return _db;
}
