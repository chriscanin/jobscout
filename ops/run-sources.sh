#!/bin/bash
#
# jobscout curated-sources wrapper (see ops/run-crawl.sh for the pattern).
#
# launchd invokes this daily. Machine-agnostic: resolves the project dir from
# its own path and puts Node 22 on PATH, loads apps/crawler/.env, then runs the
# `sources` command (curated startup-intel source tracking).
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

ENV_FILE="$PROJECT_DIR/apps/crawler/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

exec pnpm -C apps/crawler sources -- "$@"
