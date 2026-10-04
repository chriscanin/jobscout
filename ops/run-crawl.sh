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

# Put a Node 22+ toolchain first on PATH. Use the `node` already on PATH when it
# is new enough (nvm default, Homebrew, etc.); otherwise fall back to the nvm
# path this repo pins (CONTRACT §Stack). launchd starts jobs with a bare PATH,
# and an interactive shell can default to an older nvm Node, which pnpm 11
# refuses to run on, so the version is checked rather than assumed.
NODE_BIN="$HOME/.nvm/versions/node/v22.21.1/bin"
if command -v node >/dev/null 2>&1 \
  && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 22 ] 2>/dev/null; then
  NODE_BIN="$(dirname "$(command -v node)")"
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
