# Test Fixtures

Each subdirectory corresponds to one source (or supporting concern). Fixtures
are real HTTP captures used to drive adapter unit tests without live network
calls.

## Convention

```
test/fixtures/
  greenhouse/     # Real Greenhouse API JSON responses (jobs list, job detail with questions=true)
  lever/          # Real Lever Postings API JSON responses
  ashby/          # Real Ashby job board API JSON responses
  caljobs/        # Real CalJobs HTML page captures
  indeed/         # Real Indeed search-result HTML captures
  ziprecruiter/   # Real ZipRecruiter search-result HTML captures
  discord/        # Discord webhook payload examples (for notifier tests)
  discovery/      # Web-search result captures (for discovery tests)
```

## Capturing fixtures

Capturing real responses is implementation task #1 for each adapter (Wave 2).
Each fixture file should be named to reflect the request it represents, e.g.:

- `greenhouse/jobs-list-acme.json` — Greenhouse jobs list for board token "acme"
- `greenhouse/job-detail-5238290008.json` — Single job with `questions=true`
- `lever/postings-acme.json` — Lever postings for site slug "acme"

Keep captures minimal: trim description text to a few hundred characters if
needed to avoid large blobs in the repo.
