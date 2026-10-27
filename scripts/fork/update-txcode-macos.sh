#!/bin/sh
# Fork-only. Updates the installed Tx Code macOS app from Coriou/txcode prereleases.
# This is not scripts/install.sh and it does not install official T3 Code.
set -eu

help() {
  cat <<'HELP'
Usage: update-txcode-macos.sh [update|rollback]
       update-txcode-macos.sh --help

Run in a terminal on macOS. Quit Tx Code with Cmd+Q first: closing the window
leaves the bundled server up. Downloads the newest Coriou/txcode nightly for
this machine, verifies its checksum and identity, and asks before download,
backup/swap, and launch. Every answer defaults to abort; only y or yes accepts.
The downloaded disk image is deleted when the script exits, including after an
abort or a failed check. A copy that was already staged is kept.
Backups live in ~/Library/Application Support/txcode-desktop-backups.
The newest complete snapshot is kept; incomplete backups are retained.
Rollback asks for a snapshot id, copies the current app and data into a complete
quarantine, and only then replaces them. An interrupted swap renames the previous
app to Tx Code.app.aside (or the Nightly name). The next run puts that aside back
if the new app is missing, and deletes nothing if both are still present.
No unattended mode, repository override, or safety-check override is supported.
HELP
}
fail() { printf 'Tx Code updater: %s\n' "$*" >&2; exit 1; }
confirm() {
  printf '%s [y/yes to continue]: ' "$*"
  IFS= read -r answer || return 1
  case "$answer" in y|yes) return 0 ;; *) return 1 ;; esac
}
case "$#:${1:-}" in
  0:) command=update ;;
  1:update|1:rollback) command=$1 ;;
  1:--help) help; exit 0 ;;
  *) help; exit 1 ;;
esac
[ -t 0 ] || fail 'A terminal on stdin is required; pipes are refused.'
[ "$(uname -s)" = Darwin ] || fail 'macOS is required.'
case "$(uname -m)" in
  x86_64) arch=x64; machine=x86_64 ;;
  arm64) arch=arm64; machine=arm64 ;;
  *) fail 'Unsupported machine architecture.' ;;
esac
api=https://api.github.com/repos/Coriou/txcode
web=https://github.com/Coriou/txcode
apps=/Applications
root="$HOME/Library/Application Support/txcode-desktop-backups"
data1="$HOME/.txcode"
data2="$HOME/Library/Application Support/txcode-v2"
snap_bid=none
snap_version=none
snap_commit=none
process_file=
if [ "${TXCODE_UPDATE_FIXTURE:-}" = 1 ]; then
  sandbox=${TXCODE_UPDATE_FIXTURE_ROOT:?Fixture root required}
  [ -d "$sandbox" ] && [ ! -L "$sandbox" ] || fail 'Invalid fixture root.'
  sandbox=$(cd "$sandbox" && pwd -P)
  case "$sandbox" in /private/tmp/*|/tmp/*|/var/folders/*|/private/var/folders/*) ;; *) fail 'Fixture root must be temporary.' ;; esac
  apps=${TXCODE_UPDATE_APPS:?Fixture apps required}
  root=${TXCODE_UPDATE_BACKUPS:?Fixture backups required}
  process_file=${TXCODE_UPDATE_PS:?Fixture process listing required}
  data1="$sandbox/home/.txcode"
  data2="$sandbox/home/Library/Application Support/txcode-v2"
  for path in "$apps" "$root" "$process_file" "$data1" "$data2"; do
    case "$path" in "$sandbox"/*) ;; *) fail 'Unsafe fixture path.' ;; esac
    [ ! -L "$path" ] || fail 'Fixture symlink refused.'
    parent=$(dirname "$path")
    while [ ! -d "$parent" ]; do parent=$(dirname "$parent"); done
    case "$(cd "$parent" && pwd -P)/" in "$sandbox"/*) ;; *) fail 'Fixture path escapes root.' ;; esac
  done
  api=${TXCODE_UPDATE_API:-$api}
fi
old=
not_running() {
  # `command` keeps the bundle path. `comm` is clipped when ps prints more than one column.
  if [ -n "$process_file" ]; then
    listing=$(cat "$process_file")
  else
    listing=$(ps -axww -o command=) || fail 'Cannot inspect processes.'
  fi
  if printf '%s\n' "$listing" | awk \
    -v a="$apps/Tx Code.app/" \
    -v b="$apps/Tx Code (Nightly).app/" \
    -v c="$apps/Tx Code.app.aside/" \
    -v d="$apps/Tx Code (Nightly).app.aside/" \
    -v e="$apps/.txcode-update." '
      {
        sub(/^[ \t]+/, "")
        if (index($0,a)==1 || index($0,b)==1 || index($0,c)==1 || index($0,d)==1 || index($0,e)==1) found=1
      }
      END { exit !found }'; then
    fail 'Quit Tx Code with Cmd+Q. Closing the window leaves the bundled server up.'
  fi
  jobs=$(launchctl list) || fail 'Cannot inspect launchd jobs.'
  if printf '%s\n' "$jobs" | awk '$3=="net.coriou.txcode.service" && $1 ~ /^[0-9]+$/ { found=1 } END { exit !found }'; then
    fail 'Quit Tx Code with Cmd+Q. Closing the window leaves the bundled server up (net.coriou.txcode.service).'
  fi
}
find_old() {
  old=
  for path in "$apps/Tx Code.app" "$apps/Tx Code (Nightly).app"; do
    if [ -e "$path" ] || [ -L "$path" ]; then
      [ ! -L "$path" ] || fail "App symlink refused: $path"
      [ -z "$old" ] || fail "Both apps exist: $apps/Tx Code.app and $apps/Tx Code (Nightly).app"
      old=$path
    fi
  done
}
aside_path() { printf '%s.aside' "$1"; }
app_move() {
  if [ -w "$apps" ]; then mv "$1" "$2"; else sudo mv "$1" "$2"; fi
}
clear_stage() {
  for leftover in "$apps"/.txcode-update.*.app; do
    [ -e "$leftover" ] || [ -L "$leftover" ] || continue
    case "${leftover##*/}" in
      .txcode-update.*.app) ;;
      *) fail 'Unexpected staging name.' ;;
    esac
    [ ! -L "$leftover" ] || fail "Staging symlink refused: $leftover"
    if [ -w "$apps" ]; then rm -rf "$leftover"; else sudo rm -rf "$leftover"; fi
    printf 'Removed leftover staging app %s\n' "$leftover"
  done
}
recover_aside() {
  for base in "$apps/Tx Code.app" "$apps/Tx Code (Nightly).app"; do
    aside=$(aside_path "$base")
    if [ -e "$aside" ] || [ -L "$aside" ]; then
      [ ! -L "$aside" ] || fail "App symlink refused: $aside"
      if [ -e "$base" ] || [ -L "$base" ]; then
        fail "Interrupted swap left both $base and $aside. Nothing was deleted."
      fi
      app_move "$aside" "$base"
      fail "Restored $base after an interrupted swap. No data was changed. Quit Tx Code, then run the updater again."
    fi
  done
}
read_snapshot() {
  bundle=$1
  snap_bid=$(field "$bundle/Contents/Info.plist" CFBundleIdentifier) || fail 'Previous app identity failed.'
  [ "$snap_bid" = net.coriou.txcode ] || fail 'Previous app is not Tx Code.'
  snap_version=$(field "$bundle/Contents/Info.plist" CFBundleShortVersionString) || fail 'Previous app version unreadable.'
  snap_commit=$(LC_ALL=C grep -aoE '"t3codeCommitHash"[[:space:]]*:[[:space:]]*"[0-9a-fA-F]{7,40}"' \
    "$bundle/Contents/Resources/app.asar" 2>/dev/null | tail -1 | sed -E 's/.*"([0-9a-fA-F]{7,40})"$/\1/' || true)
  snap_commit=${snap_commit:-unread}
}
not_running
clear_stage
recover_aside
find_old
umask 077
created=$(mktemp -d "${TMPDIR:-/tmp}/txcode-update.XXXXXXXX") || fail 'Cannot create a temporary directory.'
tmp=$(cd "$created" && pwd -P) || { rm -rf "$created"; fail 'Cannot resolve the temporary directory.'; }
case "${tmp##*/}" in
  txcode-update.*) ;;
  *) rm -rf "$tmp"; fail 'Unexpected temporary directory name.' ;;
esac
mounted=0
workdir_ok() {
  [ -n "${tmp:-}" ] && [ -d "$tmp" ] && [ ! -L "$tmp" ] || return 1
  case "${tmp##*/}" in txcode-update.*) ;; *) return 1 ;; esac
  [ "$(cd "$tmp" && pwd -P)" = "$tmp" ] || return 1
}
discard_download() {
  if ! workdir_ok; then
    if [ -e "$tmp" ] || [ -L "$tmp" ]; then
      printf 'Tx Code updater: temporary directory changed; download was left in place.\n' >&2
    fi
    return 0
  fi
  if [ "$mounted" = 1 ]; then
    hdiutil detach "$tmp/mount" >/dev/null 2>&1 || hdiutil detach -force "$tmp/mount" >/dev/null 2>&1 || true
    if mount | grep -F " on ${tmp}/mount " >/dev/null 2>&1; then
      printf 'Tx Code updater: the disk image is still mounted at %s. Detach it with: hdiutil detach "%s"\n' "$tmp/mount" "$tmp/mount" >&2
    else
      mounted=0
      rm -rf "$tmp/mount" 2>/dev/null || true
    fi
  fi
  [ -n "${archive:-}" ] || return 0
  case "$archive" in Tx-Code-*.dmg) ;; *) return 0 ;; esac
  if [ -e "$tmp/$archive" ] || [ -L "$tmp/$archive" ] || [ -e "$tmp/SHA256SUMS" ] || [ -L "$tmp/SHA256SUMS" ]; then
    rm -f "$tmp/$archive" "$tmp/SHA256SUMS" || {
      printf 'Tx Code updater: could not remove %s from %s.\n' "$archive" "$tmp" >&2
      return 0
    }
    printf 'Removed download %s\n' "$archive"
  fi
}
remove_workdir() {
  # Only the directory mktemp just created. A replaced path is left alone.
  workdir_ok || return 0
  rm -rf "$tmp"
}
cleanup() {
  exit_status=$?
  trap - EXIT
  discard_download || true
  if [ "$mounted" = 0 ]; then remove_workdir || true; fi
  exit "$exit_status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
get() { curl -fLsS --max-filesize 2147483648 -H 'User-Agent: Tx-Code-macOS-updater' "$1" -o "$2"; }
field() { plutil -extract "$2" raw -o - "$1"; }
identity() {
  bundle=$1
  expected=$2
  [ -d "$bundle" ] && [ ! -L "$bundle" ] || return 1
  bid=$(field "$bundle/Contents/Info.plist" CFBundleIdentifier) || return 1
  [ "$bid" = net.coriou.txcode ] || return 1
  version=$(field "$bundle/Contents/Info.plist" CFBundleShortVersionString) || return 1
  [ -z "$expected" ] || [ "$version" = "$expected" ] || return 1
  executable=$(field "$bundle/Contents/Info.plist" CFBundleExecutable) || return 1
  case "$executable" in ''|*/*|.|..) return 1 ;; esac
  description=$(file -b "$bundle/Contents/MacOS/$executable") || return 1
  printf '%s\n' "$description" | grep 'Mach-O' >/dev/null || return 1
  printf '%s\n' "$description" | grep -w "$machine" >/dev/null || return 1
  unwanted=$(find "$bundle/Contents" \( -name app-update.yml -o -name dev-app-update.yml \) -print) || return 1
  [ -z "$unwanted" ] || return 1
  [ -f "$bundle/Contents/Resources/app.asar" ] || return 1
  # The packaged hash is near the end of app.asar, so the whole archive has to be scanned.
  commit=$(LC_ALL=C grep -aoE '"t3codeCommitHash"[[:space:]]*:[[:space:]]*"[0-9a-fA-F]{7,40}"' \
    "$bundle/Contents/Resources/app.asar" | tail -1 | sed -E 's/.*"([0-9a-fA-F]{7,40})"$/\1/') || true
  [ -n "$commit" ]
}
size() { du -sh "$1" | cut -f1; }
valid_child() {
  id=$1
  printf '%s\n' "$id" | grep -Eq '^[0-9]{8}T[0-9]{6}Z$' || fail 'Invalid or empty backup id.'
  [ ! -L "$root/$id" ] || fail "Backup symlink refused: $id (realpath may escape root)"
  [ -d "$root/$id" ] || fail "Missing backup: $id"
  [ "$(cd "$root/$id" && pwd -P)" = "$root/$id" ] || fail 'Backup realpath escapes root.'
  [ -f "$root/$id/BACKUP-MANIFEST.txt" ] && [ ! -L "$root/$id/BACKUP-MANIFEST.txt" ] || fail 'Missing manifest.'
}
complete_ids() {
  : > "$tmp/ids"
  for child in "$root"/*; do
    [ -e "$child/complete" ] || continue
    id=${child##*/}
    valid_child "$id"
    printf '%s\n' "$id" >> "$tmp/ids"
  done
  sort -r "$tmp/ids"
}
validate_manifest() {
  manifest=$1
  awk -F '\t' -v d1="$data1" -v d2="$data2" -v a="$apps/Tx Code.app" -v b="$apps/Tx Code (Nightly).app" '
    NF!=2 {bad=1}
    $1=="source" {if ($2!=d1 && $2!=d2 && $2!=a && $2!=b) bad=1; if(seen[$2]++) bad=1; if($2==a || $2==b) apps++ ; next}
    $1 ~ /^(tag|sha256|bundle-id|version|arch|commit)$/ {if(keys[$1]++) bad=1; next}
    {bad=1}
    END {if(apps>1 || !keys["tag"] || !keys["sha256"] || !keys["bundle-id"] || !keys["version"] || !keys["arch"] || !keys["commit"]) bad=1; exit bad}' "$manifest" || fail 'Invalid manifest or forbidden source path.'
}
prune_plan() {
  complete_ids > "$tmp/complete-list" || fail 'Cannot enumerate safe backups.'
  # The snapshot about to be written is the one complete backup that is kept.
  sed -n '1,$p' "$tmp/complete-list" > "$tmp/prune-list"
  while IFS= read -r id; do printf 'Retention would remove %s (%s)\n' "$root/$id" "$(size "$root/$id")"; done < "$tmp/prune-list"
}
prune() {
  complete_ids > "$tmp/complete-list" || fail 'Cannot enumerate safe backups.'
  sed -n '2,$p' "$tmp/complete-list" > "$tmp/prune-list"
  while IFS= read -r id; do
    valid_child "$id"
    printf 'Removing backup %s (%s)\n' "$root/$id" "$(size "$root/$id")"
    rm -rf "$root/$id"
  done < "$tmp/prune-list"
}
prepare_root() {
  [ ! -L "$root" ] || fail 'Backup root symlink refused.'
  mkdir -p "$root"
  root=$(cd "$root" && pwd -P)
}
new_backup() {
  backup="$root/$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir "$backup" || fail 'Backup timestamp already exists; try again later.'
}
# version and commit describe the backed-up app. tag and sha256 name the release that replaced it.
manifest() {
  printf 'tag\t%s\nsha256\t%s\nbundle-id\t%s\nversion\t%s\narch\t%s\ncommit\t%s\n' "$tag" "$sha" "$snap_bid" "$snap_version" "$machine" "$snap_commit" > "$backup/BACKUP-MANIFEST.txt"
  for source in "$data1" "$data2" "$old"; do
    [ -n "$source" ] || continue
    [ ! -e "$source" ] || printf 'source\t%s\n' "$source" >> "$backup/BACKUP-MANIFEST.txt"
  done
}
launch() {
  printf '%s\n' 'On the first launch of a build that contains migration 066, Tx Code rewrites some historical thread settlement timestamps in ~/.txcode from app versions 0.0.35 through 0.0.38. Putting the old app back does not undo that rewrite. Rollback restores the data backup taken before the swap. Official T3 profiles are not touched.'
  if confirm "Launch $destination?"; then open "$destination"; else printf 'Not launched.\n'; fi
}
undo_restore() {
  if [ -e "$data1" ] && [ -e "$backup/displaced/profile" ]; then mv "$data1" "$backup/bad-restore-profile"; fi
  if [ -e "$backup/displaced/profile" ]; then mv "$backup/displaced/profile" "$data1"; fi
  if [ -e "$data2" ] && [ -e "$backup/displaced/desktop" ]; then mv "$data2" "$backup/bad-restore-desktop"; fi
  if [ -e "$backup/displaced/desktop" ]; then mv "$backup/displaced/desktop" "$data2"; fi
  if [ -n "$old" ] && [ -e "$backup/displaced/${old##*/}" ]; then
    if [ -e "$old" ]; then app_move "$old" "$backup/rejected-restore.app"; fi
    app_move "$backup/displaced/${old##*/}" "$old"
  fi
  fail "Restore failed. Previous app and data were returned when copies existed. Quarantine kept at $backup."
}

if [ "$command" = rollback ]; then
  prepare_root
  complete_ids > "$tmp/complete-list" || fail 'Cannot enumerate safe backups.'
  while IFS= read -r id; do
    validate_manifest "$root/$id/BACKUP-MANIFEST.txt"
    saved_version=$(awk -F '\t' '$1=="version" {print $2}' "$root/$id/BACKUP-MANIFEST.txt")
    printf '%s  version %s  %s\n' "$id" "$saved_version" "$(size "$root/$id")"
  done < "$tmp/complete-list"
  printf 'Type the backup id to restore: '
  IFS= read -r selected || fail 'No backup selected.'
  valid_child "$selected"
  [ -f "$root/$selected/complete" ] || fail 'Backup is incomplete.'
  snapshot="$root/$selected"
  validate_manifest "$snapshot/BACKUP-MANIFEST.txt"
  destination=
  while IFS="$(printf '\t')" read -r key source; do
    [ "$key" = source ] || continue
    case "$source" in
      "$data1") stored=profile ;;
      "$data2") stored=desktop ;;
      *) stored=${source##*/}; destination=$source ;;
    esac
    [ -d "$snapshot/$stored" ] && [ ! -L "$snapshot/$stored" ] || fail "Missing snapshot source: $source"
  done < "$snapshot/BACKUP-MANIFEST.txt"
  [ -n "$destination" ] || fail 'Snapshot has no app to restore.'
  identity "$snapshot/${destination##*/}" '' || fail 'Snapshot app identity failed.'
  prune_plan
  confirm "Replace current app, $data1 and $data2 with $selected? Current contents will be quarantined." || fail 'Aborted.'
  not_running
  find_old
  tag=rollback-quarantine
  sha=none
  snap_bid=none
  snap_version=none
  snap_commit=none
  if [ -n "$old" ]; then
    identity "$old" '' || fail 'Current app identity failed.'
    snap_bid=$bid
    snap_version=$version
    snap_commit=$commit
  fi
  for source in "$data1" "$data2"; do
    [ ! -L "$source" ] || fail "Source symlink refused: $source"
  done
  new_backup
  manifest
  [ ! -e "$data1" ] || ditto "$data1" "$backup/profile"
  [ ! -e "$data2" ] || ditto "$data2" "$backup/desktop"
  [ -z "$old" ] || ditto "$old" "$backup/${old##*/}"
  touch "$backup/complete"
  mkdir "$backup/displaced"
  for pair in profile desktop; do
    case "$pair" in profile) source=$data1 ;; desktop) source=$data2 ;; esac
    [ ! -e "$source" ] || mv "$source" "$backup/displaced/$pair" || undo_restore
  done
  [ -z "$old" ] || app_move "$old" "$backup/displaced/${old##*/}" || undo_restore
  saved_version=$(awk -F '\t' '$1=="version" {print $2}' "$snapshot/BACKUP-MANIFEST.txt")
  while IFS="$(printf '\t')" read -r key source; do
    [ "$key" = source ] || continue
    case "$source" in "$data1") stored=profile ;; "$data2") stored=desktop ;; *) stored=${source##*/} ;; esac
    mkdir -p "$(dirname "$source")"
    if [ "$source" = "$destination" ]; then
      stage=$(mktemp -d "$tmp/restore.XXXXXXXX")
      ditto "$snapshot/$stored" "$stage/$stored" || undo_restore
      app_move "$stage/$stored" "$source" || undo_restore
      rmdir "$stage" || true
    else
      ditto "$snapshot/$stored" "$source" || undo_restore
    fi
  done < "$snapshot/BACKUP-MANIFEST.txt"
  identity "$destination" '' || undo_restore
  if [ "$saved_version" != none ] && [ "$version" != "$saved_version" ]; then undo_restore; fi
  rm -rf "$backup/displaced"
  prune
  launch
  exit 0
fi

get "$api/releases?per_page=100" "$tmp/releases.json" || fail 'Release lookup failed.'
i=0; best=; best_date=0; best_build=0; release_index=; ambiguous=0
while [ "$i" -lt 100 ]; do
  candidate=$(field "$tmp/releases.json" "$i.tag_name" 2>/dev/null) || break
  draft=$(field "$tmp/releases.json" "$i.draft")
  pre=$(field "$tmp/releases.json" "$i.prerelease")
  if [ "$draft" = false ] && [ "$pre" = true ] && printf '%s\n' "$candidate" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]{8}\.[0-9]+$'; then
    stamp=$(printf '%s' "$candidate" | sed -E 's/.*-nightly\.([0-9]{8})\..*/\1/; s/^0*//')
    build=$(printf '%s' "${candidate##*.}" | sed 's/^0*//'); build=${build:-0}
    if [ "$stamp" -gt "$best_date" ] || { [ "$stamp" -eq "$best_date" ] && [ "$build" -gt "$best_build" ]; }; then
      best=$candidate; best_date=$stamp; best_build=$build; release_index=$i; ambiguous=0
    elif [ "$stamp" -eq "$best_date" ] && [ "$build" -eq "$best_build" ]; then ambiguous=1; fi
  fi
  i=$((i + 1))
done
[ "$ambiguous" = 0 ] || fail 'Ambiguous newest nightly.'
[ -n "$best" ] || fail 'No qualifying nightly prerelease found.'
tag=$best
release_version=${tag#v}
archive="Tx-Code-$release_version-$arch.dmg"
i=0; dmg_size=; sums=0
while name=$(field "$tmp/releases.json" "$release_index.assets.$i.name" 2>/dev/null); do
  if [ "$name" = "$archive" ]; then dmg_size=$(field "$tmp/releases.json" "$release_index.assets.$i.size"); fi
  [ "$name" != SHA256SUMS ] || sums=1
  i=$((i + 1))
done
if [ -z "$dmg_size" ] || [ "$sums" != 1 ]; then
  [ "$arch" != arm64 ] || fail "$tag lacks $archive and/or SHA256SUMS. Apple Silicon builds are not published yet."
  fail "$tag lacks $archive and/or SHA256SUMS; refusing older nightlies."
fi
case "$dmg_size" in ''|*[!0-9]*) fail 'Invalid download size.' ;; esac
[ "$dmg_size" -gt 0 ] && [ "$dmg_size" -le 2147483648 ] || fail 'DMG size must be between 1 byte and 2 GiB.'
confirm "Download $tag: $archive ($dmg_size bytes)?" || fail 'Aborted.'
get "$web/releases/download/$tag/$archive" "$tmp/$archive" || fail 'DMG download failed.'
get "$web/releases/download/$tag/SHA256SUMS" "$tmp/SHA256SUMS" || fail 'Checksum download failed.'
for downloaded in "$tmp/$archive" "$tmp/SHA256SUMS"; do
  bytes=$(wc -c < "$downloaded")
  [ "$bytes" -gt 0 ] && [ "$bytes" -le 2147483648 ] || fail 'Empty or oversized download.'
done
sha=$(awk -v name="$archive" '$1 ~ /^[0-9a-fA-F]{64}$/ {line=$0; sub(/^[^ ]+[ ]+/,"",line); sub(/^\*/,"",line); if(line==name) {print tolower($1); n++}} END {if(n!=1) exit 1}' "$tmp/SHA256SUMS") || fail 'Missing or ambiguous checksum line.'
actual=$(shasum -a 256 "$tmp/$archive" | cut -d ' ' -f1)
[ "$sha" = "$actual" ] || fail 'Checksum mismatch.'
mkdir "$tmp/mount"
hdiutil attach -readonly -nobrowse -mountpoint "$tmp/mount" "$tmp/$archive" >/dev/null || fail 'Mount failed.'
mounted=1
find "$tmp/mount" -name '*.app' -prune -print > "$tmp/apps"
chosen=
while IFS= read -r path; do
  id=$(field "$path/Contents/Info.plist" CFBundleIdentifier) || fail 'Unreadable bundle identifier.'
  case "$id" in com.t3tools.t3code|net.coriou.txcode.dev.*) fail "Forbidden bundle identifier: $id" ;; esac
  if [ "$id" = net.coriou.txcode ]; then
    [ -z "$chosen" ] || fail 'More than one Tx Code app in DMG.'
    chosen=$path
  fi
done < "$tmp/apps"
[ -n "$chosen" ] || fail 'No Tx Code app in DMG.'
case "${chosen##*/}" in 'Tx Code.app'|'Tx Code (Nightly).app') ;; *) fail 'Unexpected bundle filename.' ;; esac
identity "$chosen" "$release_version" || fail 'Mounted app identity failed.'
destination="$apps/${chosen##*/}"
prepare_root
printf 'Install: %s\nBackup root: %s\n' "$destination" "$root"
for source in "$data1" "$data2" "$old"; do
  [ -n "$source" ] || continue
  if [ -e "$source" ]; then
    [ ! -L "$source" ] || fail "Source symlink refused: $source"
    printf 'Backup: %s (%s)\n' "$source" "$(size "$source")"
  else printf 'Absent (fresh install): %s\n' "$source"; fi
done
prune_plan
confirm 'Back up these paths and swap the app?' || fail 'Aborted.'
not_running
recover_aside
find_old
new_backup
snap_bid=none
snap_version=none
snap_commit=none
if [ -n "$old" ]; then read_snapshot "$old"; fi
manifest
[ ! -e "$data1" ] || ditto "$data1" "$backup/profile"
[ ! -e "$data2" ] || ditto "$data2" "$backup/desktop"
stage="$apps/.txcode-update.${tmp##*/}.app"
[ ! -e "$stage" ] && [ ! -L "$stage" ] || fail 'Staging path already exists.'
if [ -w "$apps" ]; then
  ditto "$chosen" "$stage"
else
  ditto "$chosen" "$tmp/staged.app"
  app_move "$tmp/staged.app" "$stage"
fi
identity "$stage" "$release_version" || fail 'Staged app identity failed.'
discard_download
if [ -n "$old" ]; then app_move "$old" "$(aside_path "$old")"; fi
if ! app_move "$stage" "$destination"; then
  if [ -n "$old" ]; then app_move "$(aside_path "$old")" "$old"; fi
  fail 'Swap failed; previous app restored.'
fi
if ! identity "$destination" "$release_version"; then
  app_move "$destination" "$backup/rejected.app"
  if [ -n "$old" ]; then app_move "$(aside_path "$old")" "$old"; fi
  fail 'Installed identity failed; previous app restored.'
fi
if [ -n "$old" ]; then app_move "$(aside_path "$old")" "$backup/${old##*/}"; fi
touch "$backup/complete"
prune
launch
