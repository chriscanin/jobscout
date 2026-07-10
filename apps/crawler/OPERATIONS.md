# jobscout crawler — operations

The crawler is an appliance: install it once on a Mac and matching jobs show up
in Discord every 3 hours. All state lives in Supabase, so the crawler machine is
disposable — moving to a new Mac is mechanical (CONTRACT §Portability).

## Commands

Run from the repo root (Node 22 must be on PATH — on the dev Mac:
`export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"`):

| Command | What it does |
|---|---|
| `pnpm crawl` | One full crawl cycle (default trigger `manual`). Add `-- --trigger launchd\|manual\|loop` to override. |
| `pnpm loop -- --interval <minutes>` | Foreground standing loop: run a cycle, sleep `<minutes>`, repeat until Ctrl-C (trigger `loop`). |
| `pnpm discover` | Web-search company discovery (separate from crawl). Prints how many companies were added. |
| `pnpm doctor` | Machine readiness check. Exit 0 all green, exit 1 otherwise, naming every failing check. |
| `pnpm db:push` | Apply `supabase/migrations/*.sql` to the DB named by `SUPABASE_DB_URL`. |

`doctor` runs four independent checks and never short-circuits: **env** (all
required vars set), **supabase** (DB reachable + the four tables and the
`criteria` row exist), **discord** (a `GET` on the webhook URL returns its
metadata — it POSTS nothing), and **anthropic** (a 1-token `claude-haiku-4-5`
call succeeds).

## Environment (`apps/crawler/.env`)

- `SUPABASE_DB_URL` — direct/session-mode Postgres connection string. **Must be a
  session-mode connection** (direct `:5432` or the session pooler) so the crawl
  advisory lock holds for the whole run.
- `ANTHROPIC_API_KEY`
- `DISCORD_WEBHOOK_URL`

## Single-flight

Every cycle takes a Postgres advisory lock (`pg_try_advisory_lock(8123407)`) on
a dedicated session held for the run. If a launchd run fires while a manual run
is in progress, the second one logs `already running`, makes zero writes, and
exits 0 — no double-post to Discord. Because advisory locks are session-scoped,
a crashed or killed run drops its connection and the lock releases automatically;
a crash cannot wedge the system.

## Scheduling (macOS launchd)

`ops/com.jobscout.crawl.plist` is a LaunchAgent that runs `ops/run-crawl.sh`
every 3 hours (`StartInterval 10800`, plus `RunAtLoad`), logging to
`~/Library/Logs/jobscout/`. `ops/run-crawl.sh` is machine-agnostic: it resolves
the repo root from its own path, puts Node 22 on PATH, loads `.env`, and runs
`pnpm crawl -- --trigger launchd`.

## Portability runbook (Mac #1 → Mac #2)

Setting up a new machine, or rebuilding after one dies, is five mechanical steps
(CONTRACT §Portability):

1. **Clone + env.** On the new Mac, clone the repo and copy `apps/crawler/.env`
   over (or recreate it with the three env vars above).
2. **Install deps.** `pnpm install`
3. **Verify.** `pnpm doctor` — proceed only when every check is green.
4. **Schedule.** `ops/install-launchd.sh` — it computes the absolute repo path
   and this machine's `$HOME`, substitutes them into
   `ops/com.jobscout.crawl.plist`, creates `~/Library/Logs/jobscout/`, copies the
   plist to `~/Library/LaunchAgents/`, and `launchctl load`s it. Idempotent —
   safe to re-run.

### Decommission the old Mac

```sh
ops/uninstall-launchd.sh
```

This `launchctl unload`s the agent and removes the plist copy from
`~/Library/LaunchAgents/`. Nothing else to migrate — all state is in Supabase and
the logs are disposable.
