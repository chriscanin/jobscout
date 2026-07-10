import type { SourceAdapter } from "@jobscout/core";
import { greenhouseAdapter } from "./greenhouse.js";
import { leverAdapter } from "./lever.js";
import { ashbyAdapter } from "./ashby.js";
import { caljobsAdapter } from "./caljobs.js";
import { indeedAdapter } from "./indeed.js";
import { ziprecruiterAdapter } from "./ziprecruiter.js";

/**
 * The single registry of all source adapters. This is the ONLY place adapters
 * are registered. Later waves edit only their own adapter file, never this list.
 */
export const ADAPTERS: SourceAdapter[] = [
  greenhouseAdapter,
  leverAdapter,
  ashbyAdapter,
  caljobsAdapter,
  indeedAdapter,
  ziprecruiterAdapter,
];
