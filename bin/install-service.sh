#!/bin/zsh
# Installs claude-office as a macOS LaunchAgent so it starts at login and is
# restarted if it crashes. Run once, after the first interactive `npm start`
# has linked WhatsApp (the QR scan needs a terminal).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.pavan.claude-office"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node)"
mkdir -p "$ROOT/logs" "$HOME/Library/LaunchAgents"

ENV_BLOCK=""
if [[ -f "$ROOT/.env" ]]; then
  while IFS='=' read -r k v; do
    [[ -z "$k" || "$k" == \#* ]] && continue
    ENV_BLOCK+="      <key>$k</key><string>${v}</string>
"
  done < "$ROOT/.env"
fi

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$ROOT/src/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
    <key>CLAUDE_OFFICE_QUIET</key><string>true</string>
$ENV_BLOCK  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$ROOT/logs/out.log</string>
  <key>StandardErrorPath</key><string>$ROOT/logs/err.log</string>
</dict>
</plist>
PL

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
echo "Installed and started $LABEL"
echo "  logs:    tail -f $ROOT/logs/out.log $ROOT/logs/err.log"
echo "  stop:    launchctl bootout gui/$(id -u)/$LABEL"
echo "  restart: launchctl kickstart -k gui/$(id -u)/$LABEL"
