#!/usr/bin/env bash
set -euo pipefail
output="${1:?Pass an evidence directory}"
mkdir -p "$output"
app="$DEVELOPER_DIR/../Applications/Icon Composer.app"
open -a "$app" "$PWD/assets/prod/app-icon.icon"
osascript - "$app" > "$output/gui.txt" 2>&1 <<'APPLESCRIPT'
on run argv
  tell application (item 1 of argv) to activate
  tell application "System Events"
    tell process "Icon Composer"
      set frontmost to true
      get name of every menu bar item of menu bar 1
      log result
      get entire contents of window 1
      log result
    end tell
  end tell
end run
APPLESCRIPT
screencapture -x "$output/gui.png"
