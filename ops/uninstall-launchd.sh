#!/bin/bash
#
# Uninstall the jobscout crawl LaunchAgent from THIS machine (spec 07 §3;
# CONTRACT §Portability). Used to decommission the old Mac when the crawler
# moves to the dedicated Mac. Idempotent: safe to run when nothing is installed.
#
# Usage:  ops/uninstall-launchd.sh
set -euo pipefail

LABEL="com.jobscout.crawl"
INSTALLED_PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ -f "$INSTALLED_PLIST" ]; then
  # Unload from launchd (ignore "not loaded" errors), then remove the copy.
  launchctl unload "$INSTALLED_PLIST" 2>/dev/null || true
  rm -f "$INSTALLED_PLIST"
  echo "jobscout: LaunchAgent unloaded and removed ($INSTALLED_PLIST)"
else
  echo "jobscout: no LaunchAgent installed at $INSTALLED_PLIST (nothing to do)"
fi

echo "jobscout: all state lives in Supabase; nothing else to migrate."
