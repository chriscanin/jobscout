/**
 * Create a person on the board and print their invite link. The board's
 * /people page does the same for the owner; this is how the first owner gets
 * in (and a way back in if the owner's own link is lost).
 *
 * Run: `pnpm -C apps/crawler invite "<name>" [--owner]`
 * The link's host comes from JOBSCOUT_URL (default: the production board).
 */
import "dotenv/config";
import { createPgDb, createPerson } from "@jobscout/core";

const args = process.argv.slice(2);
const isOwner = args.includes("--owner");
const name = args.filter((a) => a !== "--owner").join(" ").trim();
if (name === "") {
  console.error('usage: pnpm -C apps/crawler invite "<name>" [--owner]');
  process.exit(1);
}
const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("SUPABASE_DB_URL not set");
  process.exit(1);
}

const base = (process.env.JOBSCOUT_URL ?? "https://jobscout-drab.vercel.app").replace(/\/$/, "");
const { person, token } = await createPerson(createPgDb(dbUrl), { name, isOwner });
console.log(`${person.name}${person.is_owner ? " (owner)" : ""}: ${base}/join#${token}`);
process.exit(0);
