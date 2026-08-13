import { z } from "zod";

/**
 * Enums from CONTRACT §Enums. Stored in Postgres as `text` with CHECK
 * constraints (not native Postgres enums), so adding a value is a one-line
 * migration. Here they are zod enums plus their inferred TS types.
 */

export const Source = z.enum([
  "greenhouse",
  "lever",
  "ashby",
  "smartrecruiters",
  "workable",
  "recruitee",
  "caljobs",
  "indeed",
  "ziprecruiter",
  "hn",
  "remoteok",
  "remotive",
  "weworkremotely",
  "discovery",
]);
export type Source = z.infer<typeof Source>;

export const Ats = z.enum([
  "greenhouse",
  "lever",
  "ashby",
  "smartrecruiters",
  "workable",
  "recruitee",
  "workday",
  "icims",
  "taleo",
  "successfactors",
  "oracle",
  "adp",
  "brassring",
  "other",
  "unknown",
]);
export type Ats = z.infer<typeof Ats>;

export const RoleCategory = z.enum([
  "react-native",
  "react",
  "frontend",
  "fullstack",
  "other",
]);
export type RoleCategory = z.infer<typeof RoleCategory>;

/**
 * How a companies row entered the system. `seed` / `web-search` / `manual` are
 * the original channels; the rest are the curated startup-intel sources
 * (migration 0004) tracked by the crawler's `sources` command.
 */
export const DiscoveredVia = z.enum([
  "seed",
  "web-search",
  "manual",
  "yc-directory",
  "ramp-vendor-report",
  "harmonic-hot25",
  "a16z-build",
  "founders-you-should-know",
  "next-play",
  "early-days",
  "vc-a16z",
  "vc-sequoia",
  "vc-index",
  "vc-founders-fund",
  "tc-funding",
  "product-hunt",
  "pragmatic-engineer",
  "startup-lists",
]);
export type DiscoveredVia = z.infer<typeof DiscoveredVia>;

/** The curated-source subset of {@link DiscoveredVia} (everything non-legacy). */
export const CuratedSourceKey = z.enum([
  "yc-directory",
  "ramp-vendor-report",
  "harmonic-hot25",
  "a16z-build",
  "founders-you-should-know",
  "next-play",
  "early-days",
  "vc-a16z",
  "vc-sequoia",
  "vc-index",
  "vc-founders-fund",
  "tc-funding",
  "product-hunt",
  "pragmatic-engineer",
  "startup-lists",
]);
export type CuratedSourceKey = z.infer<typeof CuratedSourceKey>;

export const Difficulty = z.enum(["easy", "medium", "hard", "unknown"]);
export type Difficulty = z.infer<typeof Difficulty>;

export const Status = z.enum([
  "new",
  "notified",
  "queued",
  "applied",
  "dismissed",
  "expired",
]);
export type Status = z.infer<typeof Status>;
