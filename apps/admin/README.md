# @jobscout/admin

Personal, single-user admin for the JobScout queue. Next.js (App Router),
Auth0-gated with an email allowlist, deployed to Vercel. Four surfaces behind
one nav bar: `/jobs`, `/jobs/[id]`, `/criteria`, `/runs`.

All database access and every secret are **server-only**. The Postgres
connection and the Auth0 client are constructed lazily at request time, so
`next build` and the test suite run with no secrets present. No `NEXT_PUBLIC_`
variable carries any database/Supabase/Auth0 configuration, and no secret value
ever reaches the client bundle (proven by the S8 bundle-safety test).

## Environment variables

All are **server-side only** (Vercel project env). None is prefixed
`NEXT_PUBLIC_`. Names follow `@auth0/nextjs-auth0` v4 and the canonical
`CONTRACT.md` (`SUPABASE_DB_URL`, not the superseded
`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`).

| Variable | Purpose |
|---|---|
| `SUPABASE_DB_URL` | Direct Postgres connection string (transaction pooler is fine here). Read only in server code. |
| `AUTH0_DOMAIN` | Auth0 tenant domain, e.g. `dev-xxxx.us.auth0.com`. |
| `AUTH0_CLIENT_ID` | Auth0 application client ID. |
| `AUTH0_CLIENT_SECRET` | Auth0 application client secret. |
| `AUTH0_SECRET` | Random 32+ char key used to encrypt the session cookie. |
| `APP_BASE_URL` | Public base URL of this app, e.g. `https://jobscout-admin.vercel.app`. |
| `ADMIN_ALLOWED_EMAILS` | Comma-separated allowlist; compared case-insensitively after trimming. |

## Auth gate

Every non-`/auth/*` route is behind the Auth0 middleware. A request with no
session is redirected (302/307) to `/auth/login` with a `returnTo`. An
authenticated session whose email is not in `ADMIN_ALLOWED_EMAILS` gets a
genuine **HTTP 403** (`forbidden()` -> `src/app/forbidden.tsx`).

## Commands

```sh
pnpm --filter @jobscout/admin dev        # local dev server
pnpm --filter @jobscout/admin build      # production build (no secrets needed)
pnpm --filter @jobscout/admin typecheck  # tsc --noEmit
pnpm --filter @jobscout/admin test       # vitest (S1–S8), PGlite in-process
```
