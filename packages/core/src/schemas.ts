import { z } from "zod";
import {
  Ats,
  Difficulty,
  DiscoveredVia,
  RoleCategory,
  Source,
  Status,
} from "./enums.js";

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
  // Judged by the scorer (CONTRACT §Location filter). true = fully remote, open
  // to US candidates, no relocation required; false = anything else; null = not
  // yet judged. Gates Discord notification: only true is notified.
  remote_us_ok: z.boolean().nullable(),
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
  discovered_via: DiscoveredVia,
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

/**
 * A seed-companies file entry (spec 01 §2). The crawler reads a parsed array of
 * these and hands it to `syncSeedCompanies`; core stays fs-free.
 */
export const SeedCompany = z.object({
  name: z.string(),
  ats: Ats,
  boardToken: z.string().optional(),
  careersUrl: z.string().optional(),
});
export type SeedCompany = z.infer<typeof SeedCompany>;

/** The seed-companies file: an array of `SeedCompany`. */
export const SeedCompanies = z.array(SeedCompany);

/**
 * Validate an already-parsed seed-companies payload (core stays fs-free — the
 * crawler reads/parses the JSON file and passes the value in).
 */
export function parseSeedCompanies(json: unknown): SeedCompany[] {
  return SeedCompanies.parse(json);
}

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
  // A human-readable location requirement the scorer reads verbatim when judging
  // `remote_us_ok` (CONTRACT §Location filter). Optional so older criteria rows
  // still parse; defaults to the remote-US-only requirement.
  location_requirement: z
    .string()
    .optional()
    .default(
      "Remote-only AND based in / open to the United States. EXCLUDE hybrid, on-site, non-US locations, and any posting that requires or asks about relocation.",
    ),
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
        "react-native",
        "expo",
        "mobile",
        "ios",
        "android",
        "swift",
        "kotlin",
        "flutter",
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
  location_requirement:
    "Remote-only AND based in / open to the United States. EXCLUDE hybrid, on-site, non-US locations, and any posting that requires or asks about relocation.",
  min_salary: null,
  notify_min_score: 50,
});
