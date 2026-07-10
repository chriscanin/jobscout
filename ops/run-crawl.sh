#!/bin/bash
#
# jobscout crawl wrapper (spec 07 §3; CONTRACT §Portability).
#
# launchd invokes this with `--trigger launchd`. It is machine-agnostic and
# resolves everything at runtime from its own location, so the SAME committed
# file works on the dev Mac and the future dedicated Mac with no substitution:
#
#   - project dir : resolved from this script's own path (ops/ -> repo root)
#   - Node 22 bin : the dir of the `node` on PATH, else this repo's pinned nvm path
#
# Steps: put Node 22 on PATH, cd into the project, load .env, run one crawl.
set -euo pipefail

OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$OPS_DIR/.." && pwd)"

# Put the Node 22 toolchain first on PATH. Prefer whatever `node` is already
# resolvable (nvm default, Homebrew, etc.); the pinned nvm path is the documented
# location this repo uses on the dev Mac (CONTRACT §Stack) when PATH is bare
# (launchd starts jobs with a minimal environment).
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(dirname "$(command -v node)")"
else
  NODE_BIN="$HOME/.nvm/versions/node/v22.21.1/bin"
fi
export PATH="$NODE_BIN:$PATH"

cd "$PROJECT_DIR"

# Load apps/crawler/.env if present (SUPABASE_DB_URL, ANTHROPIC_API_KEY, DISCORD_WEBHOOK_URL).
ENV_FILE="$PROJECT_DIR/apps/crawler/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

# Pass through any launchd args (e.g. --trigger launchd) to the crawl command.
# The `--` forwards args past the pnpm script into `tsx src/cli.ts crawl`.
exec pnpm -C apps/crawler crawl -- "$@"
