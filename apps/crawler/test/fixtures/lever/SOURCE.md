# Lever Fixtures

## board-postings.json

- Attempted URL: `https://api.lever.co/v0/postings/netlify?mode=json`
- Captured: 2026-07-09
- State: blocked-capture
- Notes: Lever's v0 public postings API returned {"ok":false,"error":"Document not found"} for every board slug tested (netlify, vercel, linear, stripe, figma, notion, and 20+ others). The API endpoint is live and reachable (HTTP 200) but all known public board tokens are inactive as of 2026-07-09. This is a representative fixture constructed from the official Lever API field documentation and the field mapping in spec 02. Board token used: 'exampleco'. See board-postings.meta.json for full details.
