# Anthropic response fixtures (classifier lane)

`ANTHROPIC_API_KEY` is not set in this environment, so these Messages API
responses were **not** captured from a live `claude-haiku-4-5` /
`claude-sonnet-4-6` call. They are **representative** fixtures whose envelope
matches the real Messages API response shape used by this project
(`apps/crawler/src/anthropic.ts` `MessageResponse`): `id`, `model`, `role:
"assistant"`, `content: [{ type: "text", text }]`, `stop_reason`, `usage`.
The classifier reads the model's structured output from the single text block.

The classifier prompt asks the model to return JSON:

- **scoring** (`scoreMatch`): a JSON array of
  `{ id, role_category, match_score (0-100 int), match_reasons (1-3 strings) }`,
  one entry per surviving job id.
- **difficulty** (`rankDifficulty` LLM fallback): a JSON object
  `{ difficulty: "easy"|"medium"|"hard", difficulty_reasons (1-3 strings) }`.

| File | state | notes |
|---|---|---|
| `score-batch-20.json` | representative | 20 scoring results, **all** scores pinned outside the 40-70 re-score band (so no sonnet re-score fires). Placeholder ids `job-01`..`job-20`; the test remaps these to the UUIDs it created, since job ids are generated at test time. `model = claude-haiku-4-5`. |
| `score-ambiguous.json` | representative | two results: job A pinned to **55** (inside 40-70 → triggers one sonnet re-score) and job B pinned to **85** (outside the band → kept). ids `job-A`/`job-B` remapped by the test. `model = claude-haiku-4-5`. |
| `rescore-sonnet.json` | representative | sonnet re-score of job A pinned to **78** (final regardless of value). `model = claude-sonnet-4-6`. |
| `difficulty-fallback.json` | representative | haiku classifying `apply-pages/unknown-ats.html`, returns a valid difficulty enum + 1-3 reasons. `model = claude-haiku-4-5`. |

The score values (55 / 85 / 78, and the batch scores' avoidance of 40-70) are
the deliberately-pinned numbers the spec's band-boundary scenarios require.
Every fixture is honestly marked `representative` in its sibling
`.meta.json` because no live model call produced it.
