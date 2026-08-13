#!/bin/bash
#
# Install the jobscout crawl LaunchAgent on THIS machine (spec 07 §3;
# CONTRACT §Portability). Idempotent: safe to re-run after edits or on a fresh
# machine. Computes the absolute project dir + Node 22 bin path here, substitutes
# them into the wrapper and plist templates, ensures the log dir, installs the
# plist into ~/Library/LaunchAgents/, and (re)loads it.
#
# Usage:  ops/install-launchd.sh
set -euo pipefail

# --- Resolve paths on the current machine -----------------------------------

# Directory of this script (ops/), then the project root one level up.
OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$OPS_DIR/.." && pwd)"

# Node 22 bin dir: prefer the dir of the `node` on PATH; fall back to the nvm
# path this repo pins. This is what makes the install portable across Macs.
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(dirname "$(command -v node)")"
else
  NODE_BIN="$HOME/.nvm/versions/node/v22.21.1/bin"
fi

LOG_DIR="$HOME/Library/Logs/jobscout"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
RUN_CRAWL_SH="$OPS_DIR/run-crawl.sh"
RUN_SOURCES_SH="$OPS_DIR/run-sources.sh"

echo "jobscout: installing LaunchAgents"
echo "  project dir : $PROJECT_DIR"
echo "  node bin    : $NODE_BIN"
echo "  log dir     : $LOG_DIR"

# The wrappers self-resolve the project dir and Node bin at runtime, so they
# need no substitution — just make sure they are executable.
chmod +x "$RUN_CRAWL_SH" "$RUN_SOURCES_SH"

# --- Ensure the directories exist -------------------------------------------
mkdir -p "$LOG_DIR"
mkdir -p "$LAUNCH_AGENTS_DIR"

# --- Render + load one agent -------------------------------------------------
# Each plist's ProgramArguments must point at its wrapper's absolute path, and
# the log paths at this user's $HOME — those are the two machine-specific values.
install_agent() {
  local label="$1" wrapper_token="$2" wrapper_path="$3"
  local installed="$LAUNCH_AGENTS_DIR/$label.plist"

  sed -e "s|$wrapper_token|$wrapper_path|g" \
      -e "s|__HOME__|$HOME|g" \
      "$OPS_DIR/$label.plist" >"$installed"

  # Validate the rendered plist before loading.
  plutil -lint "$installed"

  # Unload first so a re-run picks up changes (ignore "not loaded" errors).
  launchctl unload "$installed" 2>/dev/null || true
  launchctl load "$installed"
  echo "jobscout: LaunchAgent installed and loaded ($installed)"
}

install_agent "com.jobscout.crawl" "__RUN_CRAWL_SH__" "$RUN_CRAWL_SH"
install_agent "com.jobscout.sources" "__RUN_SOURCES_SH__" "$RUN_SOURCES_SH"

echo "jobscout: crawl runs every 12 hours, sources once a day; logs in $LOG_DIR"
