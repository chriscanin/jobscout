import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { applyMigrations, createPgDb } from "@jobscout/core";

/**
 * Apply every `supabase/migrations/*.sql` file, in filename order, to the real
 * Supabase database named by `SUPABASE_DB_URL`. Reuses core's `applyMigrations`
 * so the SAME SQL that a fresh PGlite test DB gets is what reaches Supabase.
 */

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../supabase/migrations",
);

async function main(): Promise<void> {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error("SUPABASE_DB_URL is not set");
  }

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (files.length === 0) {
    console.log(`No .sql migrations found in ${MIGRATIONS_DIR}`);
    return;
  }

  const db = createPgDb(connectionString);
  console.log(`Applying ${files.length} migration(s) to Supabase:`);
  for (const file of files) console.log(`  - ${file}`);
  await applyMigrations(db, MIGRATIONS_DIR);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
