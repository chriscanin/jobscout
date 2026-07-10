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

LABEL="com.jobscout.crawl"
LOG_DIR="$HOME/Library/Logs/jobscout"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
INSTALLED_PLIST="$LAUNCH_AGENTS_DIR/$LABEL.plist"
RUN_CRAWL_SH="$OPS_DIR/run-crawl.sh"

echo "jobscout: installing LaunchAgent"
echo "  project dir : $PROJECT_DIR"
echo "  node bin    : $NODE_BIN"
echo "  log dir     : $LOG_DIR"

# The wrapper self-resolves the project dir and Node bin at runtime, so it needs
# no substitution — just make sure it is executable.
chmod +x "$RUN_CRAWL_SH"

# --- Ensure the log directory exists ----------------------------------------
mkdir -p "$LOG_DIR"

# --- Render the plist with this machine's values ----------------------------
# The plist's ProgramArguments must point at the wrapper's absolute path, and
# the log paths at this user's $HOME — those are the two machine-specific values.
mkdir -p "$LAUNCH_AGENTS_DIR"
sed -e "s|__RUN_CRAWL_SH__|$RUN_CRAWL_SH|g" \
    -e "s|__HOME__|$HOME|g" \
    "$OPS_DIR/com.jobscout.crawl.plist" >"$INSTALLED_PLIST"

# Validate the rendered plist before loading.
plutil -lint "$INSTALLED_PLIST"

# --- (Re)load into launchd --------------------------------------------------
# Unload first so a re-run picks up changes (ignore "not loaded" errors).
launchctl unload "$INSTALLED_PLIST" 2>/dev/null || true
launchctl load "$INSTALLED_PLIST"

echo "jobscout: LaunchAgent installed and loaded ($INSTALLED_PLIST)"
echo "jobscout: it will run every 3 hours; logs in $LOG_DIR"
