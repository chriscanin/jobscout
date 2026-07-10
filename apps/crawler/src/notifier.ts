import { markNotified } from "@jobscout/core";
import type { Criteria, Db, Job } from "@jobscout/core";

/**
 * Result returned by notifyNewMatches (CONTRACT §06-notifier).
 */
export interface NotifyResult {
  notifiedCount: number;
  eligibleCount: number;
}

/**
 * Discord embed field shape.
 */
interface EmbedField {
  name: string;
  value: string;
  inline: boolean;
}

/**
 * Discord embed shape (one per job).
 */
interface Embed {
  title: string;
  url: string;
  color: number;
  fields: EmbedField[];
}

/**
 * Discord webhook POST body.
 */
interface WebhookBody {
  embeds: Embed[];
  content?: string;
}

/** Color by difficulty (CONTRACT §06-notifier §Embed shape). */
const DIFFICULTY_COLORS: Record<string, number> = {
  easy: 0x2ecc71,   // 3066993
  medium: 0xf1c40f, // 15844367
  hard: 0xe74c3c,   // 15158332
  unknown: 0x95a5a6, // 9807270
};

/** Max embeds per Discord message. */
const MAX_EMBEDS_PER_MESSAGE = 10;

/** Max jobs notified per run. */
const MAX_JOBS_PER_RUN = 30;

/**
 * Resolve the priority of a role_category from the criteria.
 * Unlisted categories (incl. null) → treated as priority > 3 (i.e. 99).
 */
function rolePriority(
  roleCategory: string | null,
  criteria: Criteria,
): number {
  if (roleCategory == null) return 99;
  const entry = criteria.role_priorities.find(
    (rp) => rp.category === roleCategory,
  );
  return entry?.priority ?? 99;
}

/**
 * Build one Discord embed for a job.
 */
function buildEmbed(job: Job): Embed {
  const color = DIFFICULTY_COLORS[job.difficulty] ?? DIFFICULTY_COLORS.unknown;

  const fields: EmbedField[] = [];

  fields.push({
    name: "match_score",
    value: String(job.match_score ?? 0),
    inline: true,
  });

  fields.push({
    name: "role_category",
    value: job.role_category ?? "unknown",
    inline: true,
  });

  if (job.location != null) {
    fields.push({ name: "location", value: job.location, inline: true });
  }

  if (job.salary_raw != null) {
    fields.push({ name: "salary_raw", value: job.salary_raw, inline: true });
  }

  // difficulty field: "{difficulty} — {first reason}" or just "{difficulty}"
  const firstReason =
    job.difficulty_reasons != null && job.difficulty_reasons.length > 0
      ? job.difficulty_reasons[0]
      : null;
  const difficultyValue =
    firstReason != null
      ? `${job.difficulty} — ${firstReason}`
      : job.difficulty;
  fields.push({ name: "difficulty", value: difficultyValue, inline: true });

  if (job.apply_url != null) {
    fields.push({
      name: "apply",
      value: `[apply](${job.apply_url})`,
      inline: true,
    });
  }

  return {
    title: `${job.title} at ${job.company}`,
    url: job.url,
    color,
    fields,
  };
}

/**
 * Select jobs eligible for notification per the CONTRACT notify rule.
 *
 * SQL semantics:
 *   status = 'new'
 *   AND match_score >= notify_min_score
 *   AND remote_us_ok = true   (CONTRACT §Location filter — remote/US/no-relocation)
 *   AND (priority(role_category) <= 3 OR difficulty = 'easy')
 *   AND NOT EXISTS (prior job with same dedup_hash AND notified_at IS NOT NULL)
 *   ORDER BY match_score DESC, first_seen_at ASC, id ASC
 *
 * Priority <= 3 means react-native (1), react/frontend (2), and fullstack (3)
 * are all notified when remote_us_ok = true and the score clears the threshold;
 * role_category "other" (no priority entry → 99) is still excluded unless easy.
 * Jobs with remote_us_ok false or null are never notified.
 *
 * Then in-run dedup: keep only the first job per dedup_hash.
 */
async function selectEligible(db: Db, criteria: Criteria): Promise<Job[]> {
  const result = await db.query(
    `select j.*
     from jobs j
     where j.status = 'new'
       and j.match_score >= $1
       and j.remote_us_ok = true
       and (
         exists (
           select 1 from unnest($2::text[]) as rp_cat(cat)
                   join lateral (
                     select p.priority
                     from jsonb_array_elements($3::jsonb) as p_elem,
                          lateral (select (p_elem->>'category') as category, (p_elem->>'priority')::int as priority) as p
                     where p.category = j.role_category
                   ) as p on true
                   where p.priority <= 3
                     and rp_cat.cat = j.role_category
         )
         or j.difficulty = 'easy'
       )
       and not exists (
         select 1 from jobs prior
         where prior.dedup_hash = j.dedup_hash
           and prior.id <> j.id
           and prior.notified_at is not null
       )
     order by j.match_score desc, j.first_seen_at asc, j.id asc`,
    [
      criteria.notify_min_score,
      criteria.role_priorities
        .filter((rp) => rp.priority <= 3)
        .map((rp) => rp.category),
      JSON.stringify(criteria.role_priorities),
    ],
  );

  const jobs = result.rows as Job[];

  // In-run dedup: keep only first job per dedup_hash (already ordered by
  // match_score desc so highest scorer wins).
  const seen = new Set<string>();
  const deduped: Job[] = [];
  for (const job of jobs) {
    if (!seen.has(job.dedup_hash)) {
      seen.add(job.dedup_hash);
      deduped.push(job);
    }
  }

  return deduped;
}

/**
 * Post eligible new job matches to the Discord webhook.
 *
 * CONTRACT: §06-notifier — selection, batching, 429 handling, per-message commit.
 */
export async function notifyNewMatches(deps: {
  data: Db;
  criteria: Criteria;
  webhookUrl: string;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<NotifyResult> {
  const {
    data: db,
    criteria,
    webhookUrl,
    fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = deps;

  // 1. Select eligible jobs.
  const eligible = await selectEligible(db, criteria);
  const eligibleCount = eligible.length;

  if (eligibleCount === 0) {
    return { notifiedCount: 0, eligibleCount: 0 };
  }

  // 2. Cap at MAX_JOBS_PER_RUN; compute overflow count.
  const toNotify = eligible.slice(0, MAX_JOBS_PER_RUN);
  const overflowCount = eligibleCount - toNotify.length;

  // 3. Chunk into batches of MAX_EMBEDS_PER_MESSAGE.
  const batches: Job[][] = [];
  for (let i = 0; i < toNotify.length; i += MAX_EMBEDS_PER_MESSAGE) {
    batches.push(toNotify.slice(i, i + MAX_EMBEDS_PER_MESSAGE));
  }

  let notifiedCount = 0;

  // 4. Post each batch, committing after each 2xx.
  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    const isLastBatch = batchIdx === batches.length - 1;

    const embeds: Embed[] = batch.map(buildEmbed);

    const body: WebhookBody = { embeds };
    if (isLastBatch && overflowCount > 0) {
      body.content = `+${overflowCount} more in the admin`;
    }

    const postBody = JSON.stringify(body);

    // POST with optional 429 retry.
    let response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: postBody,
    });

    if (response.status === 429) {
      // Honor retry_after once.
      let retryAfterMs = 1000;
      try {
        const json = (await response.json()) as { retry_after?: number };
        if (typeof json.retry_after === "number") {
          retryAfterMs = json.retry_after * 1000;
        }
      } catch {
        // ignore parse errors; use default
      }
      await sleep(retryAfterMs);

      // Retry once.
      response = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: postBody,
      });
    }

    if (response.status === 429 || response.status < 200 || response.status >= 300) {
      // Stop; remaining jobs stay new.
      break;
    }

    // 2xx: mark this batch as notified.
    for (const job of batch) {
      await markNotified(db, job.id);
      notifiedCount++;
    }
  }

  return { notifiedCount, eligibleCount };
}
