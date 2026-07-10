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
  "caljobs",
  "indeed",
  "ziprecruiter",
  "discovery",
]);
export type Source = z.infer<typeof Source>;

export const Ats = z.enum([
  "greenhouse",
  "lever",
  "ashby",
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
