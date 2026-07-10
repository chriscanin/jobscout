import { z } from "zod";
import { Ats, Difficulty, RoleCategory, Source, Status } from "./enums.js";

/**
 * Zod schemas + inferred types for the domain rows and payloads defined in
 * CONTRACT §Database schema, §Source adapter interface, and §Matching criteria.
 */

/** A row of the `jobs` table (CONTRACT §Database schema → jobs). */
export const Job = z.object({
  id: z.string().uuid(),
  source: Source,
  external_id: z.string(),
  company_id: z.string().uuid().nullable(),
  url: z.string(),
  apply_url: z.string().nullable(),
  title: z.string(),
  company: z.string(),
  location: z.string().nullable(),
  is_remote: z.boolean().nullable(),
  salary_raw: z.string().nullable(),
  salary_min: z.number().int().nullable(),
  salary_max: z.number().int().nullable(),
  description: z.string().nullable(),
  posted_at: z.string().nullable(),
  first_seen_at: z.string(),
  last_seen_at: z.string(),
  role_category: RoleCategory.nullable(),
  match_score: z.number().int().nullable(),
  match_reasons: z.array(z.string()).nullable(),
  ats: Ats,
  difficulty: Difficulty,
  difficulty_reasons: z.array(z.string()).nullable(),
  status: Status,
  notes: z.string().nullable(),
  dedup_hash: z.string(),
  missing_streak: z.number().int(),
  notified_at: z.string().nullable(),
  applied_at: z.string().nullable(),
  dismissed_at: z.string().nullable(),
  raw: z.unknown().nullable(),
});
export type Job = z.infer<typeof Job>;

/** A row of the `companies` table (CONTRACT §Database schema → companies). */
export const Company = z.object({
  id: z.string().uuid(),
  name: z.string(),
  ats: Ats,
  board_token: z.string().nullable(),
  careers_url: z.string().nullable(),
  discovered_via: z.enum(["seed", "web-search", "manual"]),
  active: z.boolean(),
  last_crawled_at: z.string().nullable(),
  created_at: z.string().nullable(),
});
export type Company = z.infer<typeof Company>;

/** A row of the `crawl_runs` table (CONTRACT §Database schema → crawl_runs). */
export const CrawlRun = z.object({
  id: z.string().uuid(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  trigger: z.enum(["launchd", "manual", "loop"]),
  stats: z.unknown(),
  notified_count: z.number().int().nullable(),
  ok: z.boolean().nullable(),
});
export type CrawlRun = z.infer<typeof CrawlRun>;

/** The shape an adapter returns (CONTRACT §Source adapter interface → RawJob). */
export const RawJob = z.object({
  source: Source,
  externalId: z.string(),
  url: z.string(),
  applyUrl: z.string().optional(),
  title: z.string(),
  company: z.string(),
  location: z.string().optional(),
  salaryRaw: z.string().optional(),
  description: z.string().optional(),
  postedAt: z.string().optional(),
  atsHint: Ats.optional(),
  questions: z.unknown().optional(),
  raw: z.unknown(),
});
export type RawJob = z.infer<typeof RawJob>;

/** One entry of `criteria.value.role_priorities`. */
export const RolePriority = z.object({
  category: RoleCategory,
  priority: z.number().int(),
  keywords: z.array(z.string()),
});
export type RolePriority = z.infer<typeof RolePriority>;

/** The `criteria.value` JSON shape (CONTRACT §Matching criteria). */
export const Criteria = z.object({
  role_priorities: z.array(RolePriority),
  exclude_keywords: z.array(z.string()),
  locations: z.object({
    remote_us: z.boolean(),
    states: z.array(z.string()),
    cities: z.array(z.string()),
  }),
  min_salary: z.number().int().nullable(),
  notify_min_score: z.number().int(),
});
export type Criteria = z.infer<typeof Criteria>;

/**
 * The exact default criteria JSON from CONTRACT §Matching criteria.
 * Validated against the Criteria schema at module load so a bad edit here
 * fails fast rather than at runtime.
 */
export const DEFAULT_CRITERIA: Criteria = Criteria.parse({
  role_priorities: [
    {
      category: "react-native",
      priority: 1,
      keywords: [
        "react native",
        "mobile developer",
        "mobile engineer",
        "expo",
        "ios engineer",
        "android engineer",
      ],
    },
    {
      category: "react",
      priority: 2,
      keywords: ["react developer", "react engineer", "react.js"],
    },
    {
      category: "frontend",
      priority: 2,
      keywords: [
        "frontend",
        "front-end",
        "front end",
        "ui engineer",
        "web developer",
      ],
    },
    {
      category: "fullstack",
      priority: 3,
      keywords: ["full stack", "fullstack", "full-stack"],
    },
  ],
  exclude_keywords: [
    "angular",
    "vue",
    ".net",
    "wordpress",
    "drupal",
    "staff",
    "principal",
    "director",
    "manager",
  ],
  locations: { remote_us: true, states: ["CA"], cities: [] },
  min_salary: null,
  notify_min_score: 60,
});
