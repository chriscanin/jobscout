/**
 * Classifier (spec 05): role-match scoring + application-difficulty ranking.
 *
 * Two seams, both cheap-first:
 *
 *   A) scoreMatch — deterministic prescreen (no I/O), then batched
 *      `claude-haiku-4-5` scoring, then a single `claude-sonnet-4-6` re-score
 *      for any job whose haiku score lands in the ambiguous 40–70 band.
 *
 *   B) rankDifficulty — fixed order: (1) Greenhouse standard-questions rule
 *      (deterministic), (2) HARD_ATS_DOMAINS host rule (deterministic, no
 *      fetch), (3) LLM fallback that fetches the apply page and asks
 *      `claude-haiku-4-5` to classify per the CONTRACT rubric.
 *
 * The Anthropic client and the page-fetch helper are injected via
 * `ClassifierDeps`, so every test runs against mocks with no network. An
 * Anthropic or fetch error is caught per unit of work and collected in
 * `errors` — it never throws out of the classify step, so the affected jobs
 * simply stay unclassified and are retried next run.
 *
 * CONTRACT §Difficulty rubric, §Matching criteria; spec 05 §2.
 */

import {
  HARD_ATS_DOMAINS,
  STANDARD_GREENHOUSE_QUESTIONS,
  type Criteria,
  type Db,
  type Difficulty,
  type Job,
  type RoleCategory,
} from "@jobscout/core";
import type { AnthropicLike, MessageResponse } from "./anthropic.js";

/** Fixed model IDs (CONTRACT §Stack; spec 05 §2 — exactly these strings). */
const HAIKU_MODEL = "claude-haiku-4-5";
const SONNET_MODEL = "claude-sonnet-4-6";

/** At most this many jobs per haiku scoring request (spec 05 §2). */
const MAX_BATCH = 20;

/** Job description slice sent to the scorer (spec 05 §2). */
const SCORE_DESC_CHARS = 2_000;

/** Ambiguous band re-scored once by sonnet, inclusive (spec 05 §2). */
const RESCORE_LOW = 40;
const RESCORE_HIGH = 70;

/** The result of scoring one job (spec 05 interface). */
export interface ScoreOutcome {
  jobId: string;
  roleCategory: RoleCategory;
  matchScore: number;
  matchReasons: string[];
}

/** The result of ranking one job's difficulty (spec 05 interface). */
export interface DifficultyOutcome {
  jobId: string;
  difficulty: "easy" | "medium" | "hard";
  difficultyReasons: string[];
}

/** Injected dependencies (spec 05 interface). Mocked in every test. */
export interface ClassifierDeps {
  /** Injected Anthropic client; only `messages` is used. */
  anthropic: AnthropicLike;
  /** `CrawlCtx` fetch helper (politeness built in) returning page HTML. */
  fetchHtml: (url: string) => Promise<string>;
}

const ROLE_CATEGORIES: readonly RoleCategory[] = [
  "react-native",
  "react",
  "frontend",
  "fullstack",
  "other",
];

const DIFFICULTY_VALUES: readonly Difficulty[] = [
  "easy",
  "medium",
  "hard",
  "unknown",
];

// ---------------------------------------------------------------------------
// A) scoreMatch
// ---------------------------------------------------------------------------

/**
 * Deterministic prescreen (spec 05 §2, pure — no I/O). Lowercase
 * `title + ' ' + description`; if no `role_priorities` keyword appears in it,
 * OR any `exclude_keywords` entry appears in the lowercased **title**, the job
 * is excluded with a reason string and never reaches the LLM.
 */
export function prescreen(
  job: Job,
  criteria: Criteria,
): { excluded: true; reason: string } | { excluded: false } {
  const title = (job.title ?? "").toLowerCase();
  const haystack = `${title} ${(job.description ?? "").toLowerCase()}`;

  // Exclude if any exclude keyword appears in the TITLE (spec 05 §2).
  for (const kw of criteria.exclude_keywords) {
    if (title.includes(kw.toLowerCase())) {
      return { excluded: true, reason: `prescreen:exclude:${kw.toLowerCase()}` };
    }
  }

  // Exclude if no role-priority keyword appears anywhere in title+description.
  const anyKeyword = criteria.role_priorities.some((rp) =>
    rp.keywords.some((kw) => haystack.includes(kw.toLowerCase())),
  );
  if (!anyKeyword) {
    return { excluded: true, reason: "prescreen:no-keyword-match" };
  }

  return { excluded: false };
}

/** One record the scoring model returns per surviving job. */
interface RawScore {
  id: string;
  role_category: string;
  match_score: number;
  match_reasons: string[];
}

/** Coerce a model role_category into the contract enum (fallback `other`). */
function coerceRole(value: unknown): RoleCategory {
  return ROLE_CATEGORIES.includes(value as RoleCategory)
    ? (value as RoleCategory)
    : "other";
}

/** Clamp a model score into the 0–100 integer range. */
function clampScore(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Trim reasons to 1–3 short strings (spec 05 §2). */
function clampReasons(value: unknown): string[] {
  const arr = Array.isArray(value) ? value.map(String).filter(Boolean) : [];
  return arr.length === 0 ? ["classified"] : arr.slice(0, 3);
}

/** Concatenate the text blocks of a Messages API response. */
function responseText(res: MessageResponse): string {
  return res.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

/**
 * Extract the first JSON value (array or object) from model text, tolerating
 * ```json fences or surrounding prose.
 */
function parseJson(text: string): unknown {
  const trimmed = text.trim();
  // Strip a ```json ... ``` fence if present.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(body);
  } catch {
    // Fall back to the first {...} or [...] span.
    const start = body.search(/[[{]/);
    if (start === -1) throw new Error("no JSON found in model response");
    const open = body[start];
    const close = open === "[" ? "]" : "}";
    const end = body.lastIndexOf(close);
    if (end <= start) throw new Error("unbalanced JSON in model response");
    return JSON.parse(body.slice(start, end + 1));
  }
}

/** Build the scoring prompt for a batch (carries verbatim criteria JSON). */
function buildScorePrompt(jobs: Job[], criteria: Criteria): string {
  const compact = jobs.map((j) => ({
    id: j.id,
    title: j.title,
    company: j.company,
    location: j.location,
    description: (j.description ?? "").slice(0, SCORE_DESC_CHARS),
  }));
  return [
    "You are scoring job postings against a candidate's matching criteria.",
    "",
    "CRITERIA (verbatim JSON):",
    JSON.stringify(criteria),
    "",
    "For EACH job below, return how well it matches these criteria.",
    "role_category MUST be one of: react-native | react | frontend | fullstack | other.",
    "match_score is an integer 0-100. match_reasons is 1-3 short strings.",
    "",
    "JOBS (JSON):",
    JSON.stringify(compact),
    "",
    "Respond with ONLY a JSON array, one object per job, each:",
    '{ "id": "<job id>", "role_category": "<enum>", "match_score": <0-100>, "match_reasons": ["...", "..."] }',
  ].join("\n");
}

/** Call the model once for a batch and parse the per-job scores. */
async function scoreBatch(
  jobs: Job[],
  criteria: Criteria,
  model: string,
  deps: ClassifierDeps,
): Promise<Map<string, RawScore>> {
  const res = await deps.anthropic.messages.create({
    model,
    max_tokens: 2048,
    messages: [
      { role: "user", content: buildScorePrompt(jobs, criteria) },
    ],
  });
  const parsed = parseJson(responseText(res));
  const rows: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const byId = new Map<string, RawScore>();
  for (const row of rows) {
    const r = row as Partial<RawScore>;
    if (r && typeof r.id === "string") {
      byId.set(r.id, {
        id: r.id,
        role_category: String(r.role_category),
        match_score: clampScore(r.match_score),
        match_reasons: clampReasons(r.match_reasons),
      });
    }
  }
  return byId;
}

/**
 * Score each job 0–100 against `criteria` and assign a `role_category`
 * (spec 05 §2, S1–S3, S8).
 *
 * Order: prescreen (deterministic, 0 LLM calls for excluded jobs) → batched
 * haiku scoring (≤ 20 per request) → single sonnet re-score for any haiku
 * score in the inclusive 40–70 band. Errors are collected, never thrown.
 */
export async function scoreMatch(
  jobs: Job[],
  criteria: Criteria,
  deps: ClassifierDeps,
): Promise<{ outcomes: ScoreOutcome[]; errors: string[] }> {
  const outcomes: ScoreOutcome[] = [];
  const errors: string[] = [];

  // 1. Deterministic prescreen — no LLM call.
  const survivors: Job[] = [];
  for (const job of jobs) {
    const p = prescreen(job, criteria);
    if (p.excluded) {
      outcomes.push({
        jobId: job.id,
        roleCategory: "other",
        matchScore: 0,
        matchReasons: [p.reason],
      });
    } else {
      survivors.push(job);
    }
  }

  // 2. Batch survivors to haiku, ≤ MAX_BATCH per request.
  const haikuById = new Map<string, RawScore>();
  const scoredJobs: Job[] = [];
  for (let i = 0; i < survivors.length; i += MAX_BATCH) {
    const batch = survivors.slice(i, i + MAX_BATCH);
    try {
      const byId = await scoreBatch(batch, criteria, HAIKU_MODEL, deps);
      for (const job of batch) {
        const r = byId.get(job.id);
        if (r) {
          haikuById.set(job.id, r);
          scoredJobs.push(job);
        } else {
          errors.push(`scoreMatch: no result for job ${job.id}`);
        }
      }
    } catch (err) {
      // Whole batch failed — leave these jobs unscored, record one error.
      errors.push(`scoreMatch: haiku batch failed: ${errString(err)}`);
    }
  }

  // 3. Re-score the 40–70 band once with sonnet (sonnet result is final).
  const ambiguous = scoredJobs.filter((job) => {
    const s = haikuById.get(job.id)!.match_score;
    return s >= RESCORE_LOW && s <= RESCORE_HIGH;
  });
  const sonnetById = new Map<string, RawScore>();
  if (ambiguous.length > 0) {
    try {
      const byId = await scoreBatch(ambiguous, criteria, SONNET_MODEL, deps);
      for (const [id, r] of byId) sonnetById.set(id, r);
    } catch (err) {
      errors.push(`scoreMatch: sonnet re-score failed: ${errString(err)}`);
    }
  }

  // 4. Emit outcomes — sonnet overrides haiku when present.
  for (const job of scoredJobs) {
    const final = sonnetById.get(job.id) ?? haikuById.get(job.id)!;
    outcomes.push({
      jobId: job.id,
      roleCategory: coerceRole(final.role_category),
      matchScore: clampScore(final.match_score),
      matchReasons: clampReasons(final.match_reasons),
    });
  }

  return { outcomes, errors };
}

// ---------------------------------------------------------------------------
// B) rankDifficulty
// ---------------------------------------------------------------------------

/** Greenhouse `raw.questions` entry shape (a subset we rely on). */
interface GreenhouseQuestion {
  fields?: Array<{ name?: string }>;
}

/** The reference examples the fallback prompt must carry verbatim (spec 05 §2). */
const RUBRIC_REFERENCE = [
  "Difficulty rubric (the user's own reference examples):",
  "- easy: apply in place with only standard fields (name, email, phone, resume, links).",
  "  A Greenhouse board like the mattermost posting",
  "  (https://job-boards.greenhouse.io/mattermost/jobs/5238290008) with no personal",
  "  questions is easy.",
  "- medium: the same apply-in-place style board but with custom/personal questions",
  "  (why-us essays, salary expectations, visa status, screening questions).",
  "- hard: requires creating an account or logging into an external ATS portal, or",
  "  manually re-entering work history. Ulta Beauty's careers portal, where you must",
  "  create an account and re-enter your work history, is hard.",
].join("\n");

/** Extract the hostname of a URL, or null if unparseable. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** True when `host` equals or is a subdomain of `domain`. */
function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** Read `raw.questions` off a job row (raw may be a string or object). */
function questionsOf(job: Job): GreenhouseQuestion[] | null {
  let raw: unknown = job.raw;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (raw && typeof raw === "object" && "questions" in raw) {
    const q = (raw as { questions?: unknown }).questions;
    if (Array.isArray(q)) return q as GreenhouseQuestion[];
  }
  return null;
}

/**
 * Deterministic Greenhouse rule (spec 05 §2, step 1). Returns an outcome when
 * the job is Greenhouse with `raw.questions`, else null (fall through). A
 * question is standard when every one of its field names is in
 * STANDARD_GREENHOUSE_QUESTIONS; all standard → easy, any beyond → medium and
 * the first non-standard field is named.
 */
function greenhouseRule(job: Job): DifficultyOutcome | null {
  if (job.source !== "greenhouse") return null;
  const questions = questionsOf(job);
  if (questions === null) return null;

  const standard = new Set<string>(STANDARD_GREENHOUSE_QUESTIONS);
  for (const q of questions) {
    for (const field of q.fields ?? []) {
      const name = field?.name;
      if (typeof name === "string" && !standard.has(name)) {
        return {
          jobId: job.id,
          difficulty: "medium",
          difficultyReasons: [`greenhouse:custom-question:${name}`],
        };
      }
    }
  }
  return {
    jobId: job.id,
    difficulty: "easy",
    difficultyReasons: ["greenhouse:standard-questions-only"],
  };
}

/**
 * Deterministic HARD_ATS_DOMAINS rule (spec 05 §2, step 2). Returns an outcome
 * when `apply_url`'s host equals or is a subdomain of a hard-ATS domain, else
 * null. No fetch, no LLM.
 */
function hardAtsRule(job: Job): DifficultyOutcome | null {
  if (!job.apply_url) return null;
  const host = hostOf(job.apply_url);
  if (!host) return null;
  for (const domain of HARD_ATS_DOMAINS) {
    if (hostMatches(host, domain)) {
      return {
        jobId: job.id,
        difficulty: "hard",
        difficultyReasons: [`hard-ats:${domain}`],
      };
    }
  }
  return null;
}

/** Coerce a model difficulty into `easy|medium|hard` (fallback `medium`). */
function coerceDifficulty(value: unknown): "easy" | "medium" | "hard" {
  if (value === "easy" || value === "medium" || value === "hard") return value;
  return "medium";
}

/** Build the difficulty fallback prompt (carries the reference examples). */
function buildDifficultyPrompt(job: Job, html: string): string {
  return [
    "Classify how hard this job application is: easy, medium, or hard.",
    "",
    RUBRIC_REFERENCE,
    "",
    `Job title: ${job.title}`,
    `Company: ${job.company}`,
    `Apply URL: ${job.apply_url ?? ""}`,
    "",
    "Apply page HTML (truncated):",
    html.slice(0, 12_000),
    "",
    'Respond with ONLY a JSON object: { "difficulty": "easy|medium|hard", "difficulty_reasons": ["...", "..."] }.',
  ].join("\n");
}

/**
 * LLM fallback (spec 05 §2, step 3). Fetch the apply page and ask
 * `claude-haiku-4-5` to classify. Throws on fetch/model error so the caller
 * records the error and leaves the job unclassified.
 */
async function difficultyFallback(
  job: Job,
  deps: ClassifierDeps,
): Promise<DifficultyOutcome> {
  const html = await deps.fetchHtml(job.apply_url as string);
  const res = await deps.anthropic.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 512,
    messages: [
      { role: "user", content: buildDifficultyPrompt(job, html) },
    ],
  });
  const parsed = parseJson(responseText(res)) as {
    difficulty?: unknown;
    difficulty_reasons?: unknown;
  };
  return {
    jobId: job.id,
    difficulty: coerceDifficulty(parsed.difficulty),
    difficultyReasons: clampReasons(parsed.difficulty_reasons),
  };
}

/**
 * Rank each job's application difficulty in the fixed rubric order
 * (spec 05 §2, S4–S8): Greenhouse questions rule → HARD_ATS_DOMAINS host rule
 * → LLM fallback. The deterministic rules make ZERO fetch/LLM calls. Fallback
 * errors are collected, never thrown; those jobs stay `unknown`.
 */
export async function rankDifficulty(
  jobs: Job[],
  deps: ClassifierDeps,
): Promise<{ outcomes: DifficultyOutcome[]; errors: string[] }> {
  const outcomes: DifficultyOutcome[] = [];
  const errors: string[] = [];

  for (const job of jobs) {
    // 1. Greenhouse standard-questions rule (deterministic).
    const gh = greenhouseRule(job);
    if (gh) {
      outcomes.push(gh);
      continue;
    }
    // 2. HARD_ATS_DOMAINS host rule (deterministic, no fetch).
    const hard = hardAtsRule(job);
    if (hard) {
      outcomes.push(hard);
      continue;
    }
    // 3. LLM fallback (fetch + haiku). No apply_url ⇒ cannot fetch.
    if (!job.apply_url) {
      errors.push(`rankDifficulty: no apply_url for job ${job.id}`);
      continue;
    }
    try {
      outcomes.push(await difficultyFallback(job, deps));
    } catch (err) {
      errors.push(
        `rankDifficulty: fallback failed for job ${job.id}: ${errString(err)}`,
      );
    }
  }

  return { outcomes, errors };
}

// ---------------------------------------------------------------------------
// Persistence — the classify pipeline step
// ---------------------------------------------------------------------------

/** Stats the classify step contributes to `crawl_runs.stats.classifier`. */
export interface ClassifierStats {
  scored: number;
  ranked: number;
  errors: string[];
}

/**
 * The classify pipeline step (CONTRACT §Crawl pipeline; spec 05 §2). Selects
 * unclassified rows, scores then ranks them, and persists outcomes per job
 * with the exact guarded UPDATEs (so a mid-batch crash loses nothing already
 * written and unwritten jobs are retried next run). Returns the stats to fold
 * into `crawl_runs.stats.classifier`.
 */
export async function classifyPendingJobs(
  db: Db,
  criteria: Criteria,
  deps: ClassifierDeps,
): Promise<ClassifierStats> {
  const errors: string[] = [];

  // scoreMatch: SELECT * FROM jobs WHERE match_score IS NULL (spec 05 §2).
  const toScore = await db.query(
    `select * from jobs where match_score is null`,
  );
  const scoreResult = await scoreMatch(
    toScore.rows as Job[],
    criteria,
    deps,
  );
  errors.push(...scoreResult.errors);
  for (const o of scoreResult.outcomes) {
    await db.query(
      `update jobs set role_category = $2, match_score = $3, match_reasons = $4
       where id = $1 and match_score is null`,
      [o.jobId, o.roleCategory, o.matchScore, o.matchReasons],
    );
  }

  // rankDifficulty: SELECT * FROM jobs
  //   WHERE difficulty = 'unknown' AND match_score > 0 (spec 05 §2).
  const toRank = await db.query(
    `select * from jobs where difficulty = 'unknown' and match_score > 0`,
  );
  const rankResult = await rankDifficulty(toRank.rows as Job[], deps);
  errors.push(...rankResult.errors);
  for (const o of rankResult.outcomes) {
    await db.query(
      `update jobs set difficulty = $2, difficulty_reasons = $3
       where id = $1 and difficulty = 'unknown'`,
      [o.jobId, o.difficulty, o.difficultyReasons],
    );
  }

  return {
    scored: scoreResult.outcomes.length,
    ranked: rankResult.outcomes.length,
    errors,
  };
}

/** Difficulty enum values (exported for callers/tests that need the list). */
export const DIFFICULTY_ENUM = DIFFICULTY_VALUES;

/** Normalize an unknown thrown value to a string. */
function errString(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
