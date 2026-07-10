/**
 * Constants for the difficulty rubric (CONTRACT §Difficulty rubric).
 */

/**
 * Step 2 of the rubric: if the `apply_url` host matches one of these domains,
 * the application requires an external ATS portal and is classified **hard**
 * with no LLM call.
 */
export const HARD_ATS_DOMAINS: readonly string[] = [
  "myworkdayjobs.com",
  "icims.com",
  "taleo.net",
  "successfactors.com",
  "oraclecloud.com",
  "adp.com",
  "brassring.com",
];

/**
 * Step 1 of the rubric: the standard Greenhouse question set. If every question
 * on a Greenhouse posting is within this set, the job is **easy**; anything
 * beyond it makes the job **medium**.
 */
export const STANDARD_GREENHOUSE_QUESTIONS: readonly string[] = [
  "first_name",
  "last_name",
  "email",
  "phone",
  "resume",
  "cover_letter",
  "linkedin",
  "website",
  "location",
];
