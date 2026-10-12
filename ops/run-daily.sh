#!/bin/bash
#
# jobscout daily run: curated sources, then one full crawl, with the local
# LM Studio model loaded only for the duration. launchd starts it at 9am local
# time (ops/com.jobscout.crawl.plist), or on wake if the Mac was asleep then;
# extra args (e.g. `--trigger launchd`) pass through to the crawl.
#
# Skips unless on AC power: a 32B local model on battery overheats the laptop.
set -euo pipefail

OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$OPS_DIR/.." && pwd)"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') daily: $*"; }

if ! pmset -g batt | grep -q "AC Power"; then
  log "on battery power; skipping"
  exit 0
fi

# LLM_PROVIDER / LMSTUDIO_MODEL come from the same .env the crawler reads.
ENV_FILE="$PROJECT_DIR/apps/crawler/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi
MODEL="${LMSTUDIO_MODEL:-qwen2.5-32b-instruct}"
LMS="$(command -v lms || echo "$HOME/.lmstudio/bin/lms")"

# Unload the model on the way out, but only if this run loaded it, so a model
# loaded by hand for something else is left alone.
LOADED_HERE=false
unload_model() {
  if [ "$LOADED_HERE" = true ]; then
    "$LMS" unload "$MODEL" >/dev/null 2>&1 || true
    log "unloaded $MODEL"
  fi
}
trap unload_model EXIT

if [ "${LLM_PROVIDER:-lmstudio}" = "lmstudio" ]; then
  "$LMS" server start >/dev/null
  if ! "$LMS" ps | grep -q "$MODEL"; then
    "$LMS" load "$MODEL" --context-length 16384 -y >/dev/null
    LOADED_HERE=true
    log "loaded $MODEL"
  fi
fi

# caffeinate -is holds the Mac awake (on AC power) for each step; a catch-up
# crawl can take over an hour. A failed sources step does not skip the crawl.
STATUS=0
log "sources starting"
caffeinate -is /bin/bash "$OPS_DIR/run-sources.sh" || STATUS=$?
log "crawl starting"
caffeinate -is /bin/bash "$OPS_DIR/run-crawl.sh" "$@" || STATUS=$?
log "done (exit $STATUS)"
exit "$STATUS"
