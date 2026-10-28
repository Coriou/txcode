#!/usr/bin/env bash
# Fork-only: extract Apple's full-size legacy rendition without resizing or compositing.
set -euo pipefail

output="${1:?Pass an output directory outside the checkout}"
mkdir -p "$output"
xcodebuild -version > "$output/xcode.txt"
for variant in dev nightly prod; do
  case "$variant" in
    dev) filename=blueprint-macos-1024.png ;;
    nightly) filename=nightly-macos-1024.png ;;
    prod) filename=black-macos-1024.png ;;
  esac
  destination="$output/$variant"
  mkdir -p "$destination"
  xcrun actool "assets/$variant/app-icon.icon" \
    --compile "$destination" --platform macosx --minimum-deployment-target 12.0 \
    --standalone-icon-behavior all --app-icon app-icon \
    --output-partial-info-plist "$destination/info.plist" \
    --output-format human-readable-text > "$destination/compile.txt" 2>&1
  iconutil -c iconset "$destination/app-icon.icns" -o "$destination/app-icon.iconset"
  cp "$destination/app-icon.iconset/icon_512x512@2x.png" "$destination/$filename"
  sips -g pixelWidth -g pixelHeight "$destination/$filename"
done
