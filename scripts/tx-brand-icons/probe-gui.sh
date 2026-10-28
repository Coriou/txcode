#!/usr/bin/env bash
set -euo pipefail
output="${1:?Pass an evidence directory}"
mkdir -p "$output"
trap 'screencapture -x "$output/gui.png" || true' EXIT
app="$DEVELOPER_DIR/../Applications/Icon Composer.app"
open -a "$app" "$PWD/assets/prod/app-icon.icon"
osascript - "$app" > "$output/license.txt" 2>&1 <<'APPLESCRIPT'
on run argv
  tell application (item 1 of argv) to activate
  tell application "System Events" to tell process "Icon Composer"
    if exists static text "Icon Composer Agreement" of group 1 of window 1 then
      click button 3 of group 1 of window 1
    end if
  end tell
end run
APPLESCRIPT
open -a "$app" "$PWD/assets/prod/app-icon.icon"
osascript - "$app" > "$output/gui.txt" 2>&1 <<'APPLESCRIPT'
on run argv
  tell application (item 1 of argv) to activate
  tell application "System Events" to tell process "Icon Composer"
    repeat 100 times
      try
        if exists window 1 then exit repeat
      end try
      delay 0.2
    end repeat
    if exists static text "What’s New in Icon Composer" of scroll area 1 of group 1 of window 1 then
      click button 1 of scroll area 1 of group 1 of window 1
    end if
    delay 1
    get entire contents of window 1
    log result
    click menu bar item "File" of menu bar 1
    get name of every menu item of menu "File" of menu bar item "File" of menu bar 1
    log result
    click last menu item of menu "File" of menu bar item "File" of menu bar 1
    get entire contents of window 1
    log result
  end tell
end run
APPLESCRIPT
