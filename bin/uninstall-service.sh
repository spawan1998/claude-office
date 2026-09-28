#!/bin/zsh
set -euo pipefail
LABEL="com.pavan.claude-office"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "Removed $LABEL"
