#!/usr/bin/env bash
# Fork-only: native pre-Tahoe exports; do not resize or composite the output.
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
for variant in prod dev nightly; do
  case "$variant" in
    prod) filename=black-macos-1024.png ;;
    dev) filename=blueprint-macos-1024.png ;;
    nightly) filename=nightly-macos-1024.png ;;
  esac
  destination="$output/$variant"
  mkdir -p "$destination"
  open -a "$app" "$PWD/assets/$variant/app-icon.icon"
  osascript - "$app" "$destination" "$filename" > "$destination/gui.txt" 2>&1 <<'APPLESCRIPT'
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
    if exists radio button 3 of radio group 1 of group 1 of toolbar 1 of window 1 then
      click radio button 3 of radio group 1 of group 1 of toolbar 1 of window 1
    end if
    click menu bar item "File" of menu bar 1
    click last menu item of menu "File" of menu bar item "File" of menu bar 1
    repeat 100 times
      if exists sheet 1 of window 1 then exit repeat
      delay 0.2
    end repeat
    tell group 1 of scroll area 1 of group 1 of sheet 1 of window 1
      click pop up button "Platform"
      click menu item "macOS pre-Tahoe" of menu 1 of pop up button "Platform"
      repeat 100 times
        set selectedPlatform to (value of pop up button "Platform") as text
        if selectedPlatform contains "macOS pre-Tahoe" then exit repeat
        delay 0.2
      end repeat
      log selectedPlatform
      if selectedPlatform does not contain "macOS pre-Tahoe" then error "Wrong platform selected"
      set selectedAppearance to (value of pop up button "Appearance") as text
      if selectedAppearance is not "Default" then
        click pop up button "Appearance"
        click menu item "Default" of menu 1 of pop up button "Appearance"
      end if
    end tell
    set selectedSize to (value of pop up button "Size" of group 2 of scroll area 1 of group 1 of sheet 1 of window 1) as text
    if selectedSize is not "1024pt" then error "Wrong export size"
    log selectedSize
    do shell script "/usr/sbin/screencapture -x " & quoted form of ((item 2 of argv) & "/selected-platform.png")
    click button 2 of group 1 of sheet 1 of window 1
    repeat 100 times
      if exists sheet 1 of sheet 1 of window 1 then exit repeat
      delay 0.2
    end repeat
    set value of text field "Export As:" of splitter group 1 of sheet 1 of sheet 1 of window 1 to (item 3 of argv)
    keystroke "g" using {command down, shift down}
    delay 0.5
    keystroke (item 2 of argv)
    key code 36
    delay 0.5
    click button "Export" of splitter group 1 of sheet 1 of sheet 1 of window 1
    repeat 150 times
      try
        do shell script "/usr/bin/test -s " & quoted form of ((item 2 of argv) & "/" & (item 3 of argv))
        exit repeat
      on error
        delay 0.2
      end try
    end repeat
    repeat 100 times
      if not (exists sheet 1 of window 1) then exit repeat
      delay 0.2
    end repeat
    key code 13 using command down
    repeat 100 times
      if (count windows) is 0 then exit repeat
      delay 0.2
    end repeat
    if (count windows) is not 0 then error "Document did not close cleanly"
  end tell
end run
APPLESCRIPT
  test -s "$destination/$filename"
  sips -g pixelWidth -g pixelHeight "$destination/$filename"
done
git diff --exit-code -- 'assets/*/app-icon.icon/'
