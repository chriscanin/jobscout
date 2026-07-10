# jobscout

Personal AI job search engine: crawls job boards on a schedule, ranks jobs by application difficulty (easy / medium / hard), stores them in Supabase, notifies Discord, and provides an Auth0-gated admin app. No auto-apply.

- **Plan / spec index:** [SPEC.md](SPEC.md)
- **Canonical contract:** [.agent/specs/atdd/CONTRACT.md](.agent/specs/atdd/CONTRACT.md)
- **End-to-end proof:** `pnpm e2e` — the whole pipeline against a real local fixture server + PGlite, zero external traffic. See [apps/crawler/test/e2e/README.md](apps/crawler/test/e2e/README.md).

## Toolchain

Node 22, pnpm workspaces. On the dev Mac, Node 22 lives at
`~/.nvm/versions/node/v22.21.1/bin` — activate it first:

```bash
export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"
pnpm install
pnpm typecheck && pnpm test && pnpm build   # all green
pnpm e2e                                     # end-to-end win condition, exits 0
```

## Going live

End to end, from an empty account to a scheduled crawler + deployed admin. Every
command assumes Node 22 is on `PATH` (see above). Copy `.env.example` and fill in
real values as you go.

1. **Create a Supabase project.** In the Supabase dashboard, create a project.
   From *Project Settings → Database → Connection string*, take the **session-mode**
   connection string (direct `:5432`, or the *session* pooler — **not** the
   transaction pooler; the crawler needs `pg_try_advisory_lock` to hold for a
   whole run). Put it in `apps/crawler/.env` as `SUPABASE_DB_URL`.

2. **Push the schema.** This runs every file in `supabase/migrations/` in order
   against the real DB (a tiny `pg` runner — no Supabase CLI needed):
   ```bash
   pnpm db:push
   ```

3. **Create a Discord webhook.** In your Discord server: *Channel → Edit → Integrations
   → Webhooks → New Webhook*, copy the URL into `apps/crawler/.env` as
   `DISCORD_WEBHOOK_URL`. Use a **test channel** for the first live run.

4. **Set the Anthropic key.** Put a real key in `apps/crawler/.env` as
   `ANTHROPIC_API_KEY` (classification uses `claude-haiku-4-5`, with
   `claude-sonnet-4-6` only for ambiguous match scores).

5. **Create an Auth0 application (for the admin).** In Auth0, create a *Regular
   Web Application*. Set its Allowed Callback URL to
   `https://<your-admin-domain>/auth/callback` and Allowed Logout URL to your
   admin base URL. These are the **@auth0/nextjs-auth0 v4** env names (v3's
   `AUTH0_BASE_URL` / `AUTH0_ISSUER_BASE_URL` are gone):
   - `AUTH0_DOMAIN` (hostname only, e.g. `dev-xxxx.us.auth0.com`)
   - `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`
   - `AUTH0_SECRET` (`openssl rand -hex 32`)
   - `APP_BASE_URL` (the deployed admin URL, no trailing slash)
   - `ADMIN_ALLOWED_EMAILS` (comma-separated login allowlist)
   - `SUPABASE_DB_URL` (the admin may use the **transaction** pooler here)

6. **Verify readiness.** `pnpm doctor` checks env, the DB (4 tables + criteria
   row present), the Discord webhook (GET only — posts nothing), and Anthropic:
   ```bash
   pnpm doctor      # must exit 0 before going further
   ```

7. **First real crawl.** Confirm `apps/crawler/seeds/companies.seed.json` lists
   the boards you want (Mattermost is seeded), then:
   ```bash
   pnpm --filter ./apps/crawler run crawl -- --trigger manual
   ```
   Exits 0; the newest `crawl_runs` row has `ok=true` and `stats.greenhouse.fetched > 0`;
   a Discord message with ≤ 10 embeds lands in your test channel. Run it again —
   no new message, and `last_seen_at` advances (idempotent). Full checklist:
   [apps/crawler/test/e2e/README.md](apps/crawler/test/e2e/README.md#live-smoke-checklist-manual-once-real-traffic).

8. **Deploy the admin to Vercel.** Import the repo, set the project root to
   `apps/admin`, and add the Auth0 + `SUPABASE_DB_URL` env vars from step 5.
   Deploy, log in as an allowlisted email, and confirm `/jobs` shows the crawled
   jobs. (Browser-gated Scenario 6 in the e2e README covers the exact check.)

9. **Schedule the crawler (launchd).** On the machine that will run the crawler:
   ```bash
   ops/install-launchd.sh
   ```
   This resolves the project dir + Node 22 bin for this machine, installs
   `com.jobscout.crawl.plist` into `~/Library/LaunchAgents/`, and loads it. The
   crawl then fires at load and every 3 hours; logs go to
   `~/Library/Logs/jobscout/`. Uninstall with `ops/uninstall-launchd.sh`.

10. **Later: move to the dedicated Mac.** All state lives in Supabase, so the
    crawler machine is disposable. On the new Mac: clone the repo, copy
    `apps/crawler/.env`, `pnpm install`, `pnpm doctor` green, `ops/install-launchd.sh`.
    Decommission the old one with `ops/uninstall-launchd.sh`. Nothing else to migrate.
