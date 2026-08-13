import type { SourceAdapter } from "@jobscout/core";
import { greenhouseAdapter } from "./greenhouse.js";
import { leverAdapter } from "./lever.js";
import { ashbyAdapter } from "./ashby.js";
import { smartrecruitersAdapter } from "./smartrecruiters.js";
import { workableAdapter } from "./workable.js";
import { recruiteeAdapter } from "./recruitee.js";
import { caljobsAdapter } from "./caljobs.js";
import { indeedAdapter } from "./indeed.js";
import { ziprecruiterAdapter } from "./ziprecruiter.js";
import { hnAdapter } from "./hn.js";
import { remoteokAdapter } from "./remoteok.js";
import { remotiveAdapter } from "./remotive.js";
import { weworkremotelyAdapter } from "./weworkremotely.js";

/**
 * The single registry of all source adapters. This is the ONLY place adapters
 * are registered. Later waves edit only their own adapter file, never this list.
 */
export const ADAPTERS: SourceAdapter[] = [
  greenhouseAdapter,
  leverAdapter,
  ashbyAdapter,
  smartrecruitersAdapter,
  workableAdapter,
  recruiteeAdapter,
  caljobsAdapter,
  indeedAdapter,
  ziprecruiterAdapter,
  hnAdapter,
  remoteokAdapter,
  remotiveAdapter,
  weworkremotelyAdapter,
];
