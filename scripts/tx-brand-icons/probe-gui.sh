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
  end tell
end run
APPLESCRIPT
open -a "$app" "$PWD/assets/prod/app-icon.icon"
osascript - "$app" "$output" >> "$output/gui.txt" 2>&1 <<'APPLESCRIPT'
on run argv
  tell application (item 1 of argv) to activate
  tell application "System Events" to tell process "Icon Composer"
    repeat 150 times
      set ready to false
      try
        repeat with candidate in windows
          if name of candidate contains "app-icon" then set ready to true
        end repeat
      end try
      if ready then exit repeat
      delay 0.2
    end repeat
    click radio button 2 of radio group 1 of group 1 of toolbar 1 of window 1
    click menu bar item "File" of menu bar 1
    click last menu item of menu "File" of menu bar item "File" of menu bar 1
    repeat 100 times
      if exists sheet 1 of window 1 then exit repeat
      delay 0.2
    end repeat
    tell group 1 of scroll area 1 of group 1 of sheet 1 of window 1
      click pop up button "Platform"
      get name of every menu item of menu 1 of pop up button "Platform"
      log result
      click menu item "macOS pre-Tahoe" of menu 1 of pop up button "Platform"
      repeat 100 times
        if value of pop up button "Platform" is "macOS pre-Tahoe" then exit repeat
        delay 0.2
      end repeat
      get value of pop up button "Platform"
      log result
      if result is not "macOS pre-Tahoe" then error "Wrong platform selected"
      get value of pop up button "Appearance"
      log result
    end tell
    get value of pop up button "Size" of group 2 of scroll area 1 of group 1 of sheet 1 of window 1
    log result
    click button 2 of group 1 of sheet 1 of window 1
    repeat 100 times
      if exists sheet 1 of sheet 1 of window 1 then exit repeat
      delay 0.2
    end repeat
    set value of text field "Export As:" of splitter group 1 of sheet 1 of sheet 1 of window 1 to "black-macos-1024.png"
    keystroke "g" using {command down, shift down}
    delay 0.5
    keystroke (item 2 of argv)
    key code 36
    delay 0.5
    click button "Export" of splitter group 1 of sheet 1 of sheet 1 of window 1
    repeat 150 times
      if exists disk item ((item 2 of argv) & "/black-macos-1024.png") then exit repeat
      delay 0.2
    end repeat
  end tell
end run
APPLESCRIPT
