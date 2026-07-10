/**
 * One-off: classify (score + rank) every unclassified job already in the DB and
 * send Discord notifications — WITHOUT re-fetching the boards. Useful after a
 * classifier change, or to finish a run whose fetch already populated `jobs`.
 *
 * Run: `pnpm -C apps/crawler classify`
 */
import "dotenv/config";
import { createPgDb, getCriteria } from "@jobscout/core";
import { createHttpClient } from "./http.js";
import { createLlmClient } from "./llm.js";
import { classifyPendingJobs } from "./classifier.js";
import { notifyNewMatches } from "./notifier.js";

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("SUPABASE_DB_URL not set");
  process.exit(1);
}

const db = createPgDb(dbUrl);
const criteria = await getCriteria(db);
const llm = createLlmClient();
const fetchHelper = createHttpClient();
const fetchHtml = async (url: string) => (await fetchHelper(url)).text();

console.log(`classifier LLM provider: ${llm.label}`);
const before = await db.query(
  `select count(*) filter (where match_score is null) as unscored,
          count(*) filter (where difficulty = 'unknown' and match_score > 0) as unranked
   from jobs`,
);
console.log("to do:", before.rows[0]);

const stats = await classifyPendingJobs(db, criteria, { llm, fetchHtml });
console.log("classify stats:", { scored: stats.scored, ranked: stats.ranked, errors: stats.errors.length });
if (stats.errors.length) console.log("first errors:", stats.errors.slice(0, 5));

const webhookUrl = process.env.DISCORD_WEBHOOK_URL ?? "";
const notify = await notifyNewMatches({
  data: db,
  criteria,
  webhookUrl,
  fetchImpl: (input, init) => fetchHelper(input as string, init),
});
console.log(`notified ${notify.notifiedCount} jobs to Discord`);
process.exit(0);
