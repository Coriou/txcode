#!/bin/bash
# Fork-only (Tx Code): updates the installed Tx Code macOS app from Coriou/txcode nightly
# prereleases. It is not scripts/install.sh and never installs official T3 Code.
set -euo pipefail

usage() {
  cat <<'HELP'
Usage: update-txcode-macos.sh [command] [options]

Installs the newest Tx Code nightly for this Mac after backing up your app data.

Commands:
  update          Default. Download, verify, quit Tx Code, back up, install, reopen.
  status          Show the installed and latest versions and the backups on disk.
  rollback [ID]   Restore an earlier app and its data. Current state is backed up first.
  prune-legacy    Delete backups made by older versions of this script (asks first).

Options:
  -y, --yes       Answer yes to every question.
  -n, --dry-run   Show what would happen without changing anything.
  --version TAG   Install this release tag instead of the newest nightly.
  --force         Reinstall even when already up to date.
  -h, --help      Show this help.

Backups live in ~/Library/Application Support/txcode-desktop-backups; the newest 3
are kept. They hold databases, settings, secrets, attachments, desktop storage and
the previous app. Worktrees, logs and caches are never copied or changed.

Exit codes: 0 done or up to date, 1 error, 2 usage, 3 cancelled, 4 Tx Code still
running, 5 download or checksum failed, 6 safety check failed, 7 not enough space.
HELP
}

readonly bundle_id=net.coriou.txcode
readonly backup_format=txcode-backup-v3
readonly keep_backups=3
readonly E_FAIL=1 E_USAGE=2 E_CANCEL=3 E_RUNNING=4 E_NETWORK=5 E_SAFETY=6 E_SPACE=7
# What first-launch migrations can change. Worktrees, logs, caches and browser artifacts are excluded.
readonly databases=(statev2.sqlite state.sqlite)
readonly userdata_entries=(settings.json client-settings.json desktop-settings.json
  connection-catalog.json saved-environments.json environment-id keybindings.json
  keybindings-migrations secrets themes attachments)
# Electron storage the web client migrates: IndexedDB caches and localStorage drafts.
readonly desktop_entries=("Local Storage" IndexedDB WebStorage "Local State" Preferences Cookies)

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != dumb ]; then
  c_bold=$'\033[1m' c_red=$'\033[31m' c_green=$'\033[32m' c_yellow=$'\033[33m' c_off=$'\033[0m'
else
  c_bold='' c_red='' c_green='' c_yellow='' c_off=''
fi
step() { printf '%s==>%s %s\n' "$c_bold" "$c_off" "$*"; }
info() { printf '    %s\n' "$*"; }
row() { printf '  %-10s %s\n' "$1" "$2"; }
success() { printf '%s%s%s\n' "$c_green" "$*" "$c_off"; }
warn() { printf '%swarning:%s %s\n' "$c_yellow" "$c_off" "$*" >&2; }
die() {
  local code=$1
  shift
  printf '%serror:%s %s\n' "$c_red" "$c_off" "$*" >&2
  exit "$code"
}

command=update yes=0 dry_run=0 force=0 want_tag='' rollback_id='' command_given=0
is_id() { [[ $1 =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; }
while [ $# -gt 0 ]; do
  case $1 in
    update | status | rollback | prune-legacy)
      [ "$command_given" = 0 ] || die $E_USAGE "Only one command is allowed. See --help."
      command=$1 command_given=1
      ;;
    -y | --yes) yes=1 ;;
    -n | --dry-run) dry_run=1 ;;
    --force) force=1 ;;
    --version)
      [ $# -ge 2 ] || die $E_USAGE '--version needs a release tag, for example v0.1.6-nightly.20261030.3919.'
      want_tag=$2
      shift
      ;;
    --version=*) want_tag=${1#*=} ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      if [ "$command" = rollback ] && [ -z "$rollback_id" ] && is_id "$1"; then
        rollback_id=$1
      else
        die $E_USAGE "Unknown argument: $1. See --help."
      fi
      ;;
  esac
  shift
done
if [ -n "$want_tag" ] && ! [[ $want_tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  die $E_USAGE "Not a release tag: $want_tag"
fi

[ "$(uname -s)" = Darwin ] || die $E_FAIL 'This updater runs on macOS only.'
case "$(uname -m)" in
  x86_64) arch=x64 machine=x86_64 ;;
  arm64) arch=arm64 machine=arm64 ;;
  *) die $E_FAIL 'Unsupported Mac architecture.' ;;
esac

api=https://api.github.com/repos/Coriou/txcode
web=https://github.com/Coriou/txcode
apps=/Applications
root="$HOME/Library/Application Support/txcode-desktop-backups"
data1="$HOME/.txcode"
data2="$HOME/Library/Application Support/txcode-v2"
process_file='' clone_override='' quit_timeout=30
if [ "${TXCODE_UPDATE_FIXTURE:-}" = 1 ]; then
  sandbox=${TXCODE_UPDATE_FIXTURE_ROOT:?Fixture root required}
  [ -d "$sandbox" ] && [ ! -L "$sandbox" ] || die $E_FAIL 'Invalid fixture root.'
  sandbox=$(cd "$sandbox" && pwd -P)
  case "$sandbox" in /private/tmp/* | /tmp/* | /var/folders/* | /private/var/folders/*) ;; *) die $E_FAIL 'Fixture root must be temporary.' ;; esac
  apps=${TXCODE_UPDATE_APPS:?Fixture apps required}
  root=${TXCODE_UPDATE_BACKUPS:?Fixture backups required}
  process_file=${TXCODE_UPDATE_PS:?Fixture process listing required}
  data1="$sandbox/home/.txcode"
  data2="$sandbox/home/Library/Application Support/txcode-v2"
  for path in "$apps" "$root" "$process_file" "$data1" "$data2"; do
    case "$path" in "$sandbox"/*) ;; *) die $E_FAIL 'Unsafe fixture path.' ;; esac
    [ ! -L "$path" ] || die $E_FAIL 'Fixture symlink refused.'
  done
  api=${TXCODE_UPDATE_API:-$api}
  clone_override=${TXCODE_UPDATE_CLONE:-}
  quit_timeout=${TXCODE_UPDATE_QUIT_TIMEOUT:-$quit_timeout}
fi

mutating=0
if [ "$dry_run" = 0 ] && [ "$command" != status ]; then mutating=1; fi
if [ "$mutating" = 1 ] && [ "$yes" = 0 ] && [ ! -t 0 ]; then
  die $E_USAGE 'No terminal to ask questions on. Run this in Terminal, or pass --yes.'
fi

umask 077
created=$(mktemp -d "${TMPDIR:-/tmp}/txcode-update.XXXXXXXX") || die $E_FAIL 'Cannot create a temporary directory.'
tmp=$(cd "$created" && pwd -P)
mounted=0 locked=0 stage='' backup=''
# Only ever remove the directory mktemp just created.
workdir_ok() {
  [ -d "$tmp" ] && [ ! -L "$tmp" ] || return 1
  case "${tmp##*/}" in txcode-update.*) return 0 ;; *) return 1 ;; esac
}
as_needed() { if [ -w "$apps" ]; then "$@"; else sudo "$@"; fi; }
app_move() { as_needed mv "$1" "$2"; }
cleanup() {
  local status=$?
  trap - EXIT
  if [ "$mounted" = 1 ]; then
    hdiutil detach "$tmp/mount" -quiet 2>/dev/null || hdiutil detach "$tmp/mount" -force -quiet 2>/dev/null || true
    if mount | grep -F " on $tmp/mount " >/dev/null 2>&1; then
      warn "The disk image is still mounted. Detach it with: hdiutil detach \"$tmp/mount\""
    else
      mounted=0
    fi
  fi
  if [ -n "$stage" ] && { [ -e "$stage" ] || [ -L "$stage" ]; }; then as_needed rm -rf "$stage" || true; fi
  if [ "$status" != 0 ] && [ -n "$backup" ] && [ -d "$backup" ] && [ ! -f "$backup/complete" ]; then
    warn "Incomplete backup ${backup##*/} cannot be restored; the next run removes it."
  fi
  if [ "$mounted" = 0 ] && workdir_ok; then rm -rf "$tmp"; fi
  if [ "$locked" = 1 ]; then rm -f "$root/.updater-lock/pid" && rmdir "$root/.updater-lock" || true; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

# ---- helpers ---------------------------------------------------------------

json() { plutil -extract "$2" raw -o - "$1" 2>/dev/null; }
plist() { plutil -extract "$2" raw -o - "$1/Contents/Info.plist" 2>/dev/null; }
bundle_version() { [ "$(plist "$1" CFBundleIdentifier)" = "$bundle_id" ] && plist "$1" CFBundleShortVersionString; }
human_kb() { awk -v k="$1" 'BEGIN { if (k >= 1048576) printf "%.1f GB", k / 1048576; else if (k >= 1024) printf "%.0f MB", k / 1024; else printf "%d KB", k }'; }
size_kb() { du -sk "$1" | awk '{print $1}'; }
sql_string() { printf '%s' "$1" | sed "s/'/''/g"; }
fetch() {
  local mode=$1
  shift
  curl "$mode" -fL --connect-timeout 15 --speed-limit 1024 --speed-time 60 --max-time 1800 \
    --max-filesize 2147483648 -H 'User-Agent: Tx-Code-macOS-updater' "$1" -o "$2"
}
ask() {
  local answer
  [ "$yes" = 0 ] || return 0
  if [ "$2" = y ]; then printf '%s [Y/n] ' "$1"; else printf '%s [y/N] ' "$1"; fi
  IFS= read -r answer || return 1
  case $answer in
    '') [ "$2" = y ] ;;
    [yY] | [yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

# The bundled server keeps running after the window closes, so match every process in the bundle.
app_processes() {
  local listing
  if [ -n "$process_file" ]; then listing=$(cat "$process_file"); else listing=$(ps -axww -o command=); fi
  printf '%s\n' "$listing" | awk -v a="$apps/Tx Code.app/" -v b="$apps/Tx Code (Nightly).app/" \
    -v c="$apps/Tx Code.app.aside/" -v d="$apps/Tx Code (Nightly).app.aside/" -v e="$apps/.txcode-update." '
    { sub(/^[ \t]+/, ""); if (index($0, a) == 1 || index($0, b) == 1 || index($0, c) == 1 || index($0, d) == 1 || index($0, e) == 1) print }'
}
is_running() { [ -n "$(app_processes)" ]; }
ensure_stopped() {
  if launchctl list | awk '$3 == "net.coriou.txcode.service" && $1 ~ /^[0-9]+$/ { f = 1 } END { exit !f }'; then
    die $E_RUNNING 'The Tx Code background service (net.coriou.txcode.service) is running. Stop it, then run this again.'
  fi
  is_running || return 0
  step 'Quitting Tx Code'
  osascript -e "quit app id \"$bundle_id\"" >/dev/null 2>&1 || true
  local waited=0
  while is_running; do
    [ "$waited" -lt "$quit_timeout" ] || die $E_RUNNING "Tx Code did not quit within ${quit_timeout}s; a dialog may be waiting, or Terminal lacks permission to control it. Quit Tx Code with Cmd+Q, then run this again. Nothing was changed."
    sleep 1
    waited=$((waited + 1))
  done
}

find_app() {
  local path
  old='' installed_version=''
  for path in "$apps/Tx Code.app" "$apps/Tx Code (Nightly).app"; do
    [ -e "$path" ] || [ -L "$path" ] || continue
    [ ! -L "$path" ] || die $E_SAFETY "Refusing a symlinked app: $path"
    [ -z "$old" ] || die $E_SAFETY "Both $apps/Tx Code.app and $apps/Tx Code (Nightly).app exist. Move the one you do not use to the Trash, then run this again."
    old=$path
  done
  [ -z "$old" ] || installed_version=$(bundle_version "$old") || die $E_SAFETY "$old is not a Tx Code app."
}

identity() {
  local bundle=$1 expected=$2 executable description
  [ -d "$bundle" ] && [ ! -L "$bundle" ] || return 1
  [ "$(bundle_version "$bundle")" = "$expected" ] || return 1
  executable=$(plist "$bundle" CFBundleExecutable) || return 1
  case "$executable" in '' | */* | . | ..) return 1 ;; esac
  description=$(file -b "$bundle/Contents/MacOS/$executable") || return 1
  [[ $description == *Mach-O* && $description == *"$machine"* ]] || return 1
  [ -z "$(find "$bundle/Contents" \( -name app-update.yml -o -name dev-app-update.yml \) -print)" ] || return 1
  [ -f "$bundle/Contents/Resources/app.asar" ] || return 1
  # The packaged commit hash sits near the end of app.asar, so the whole archive is scanned.
  LC_ALL=C grep -aqE '"t3codeCommitHash"[[:space:]]*:[[:space:]]*"[0-9a-fA-F]{7,40}"' "$bundle/Contents/Resources/app.asar"
}

# ---- backups ---------------------------------------------------------------

backup_ids() {
  local path id
  [ -d "$root" ] || return 0
  for path in "$root"/*; do
    id=${path##*/}
    if is_id "$id" && [ -d "$path" ] && [ ! -L "$path" ]; then printf '%s\n' "$id"; fi
  done | sort -r
}
mget() { awk -F '\t' -v k="$2" '$1 == k { print $2; exit }' "$root/$1/manifest"; }
is_v3() { [ -f "$root/$1/manifest" ] && [ ! -L "$root/$1/manifest" ] && [ "$(mget "$1" format)" = "$backup_format" ]; }
is_complete() { is_id "$1" && [ -d "$root/$1" ] && [ ! -L "$root/$1" ] && is_v3 "$1" && [ -f "$root/$1/complete" ]; }
complete_ids() { backup_ids | while IFS= read -r id; do if is_complete "$id"; then printf '%s\n' "$id"; fi; done; }
legacy_ids() { backup_ids | while IFS= read -r id; do if ! is_v3 "$id"; then printf '%s\n' "$id"; fi; done; }
remove_backup() {
  is_id "$1" && [ ! -L "$root/$1" ] || die $E_SAFETY "Refusing to remove $root/$1."
  rm -rf "${root:?}/$1" 2>/dev/null || as_needed rm -rf "${root:?}/$1"
}
prune() {
  local protected=$1 kept=0 id
  while IFS= read -r id; do
    if [ "$kept" -lt "$keep_backups" ]; then
      kept=$((kept + 1))
    elif [ "$id" != "$protected" ]; then
      info "Removing old backup $id"
      remove_backup "$id"
    fi
  done < <(complete_ids)
}

can_clone() {
  local path mount_point target=$root
  [ "$clone_override" != 0 ] || return 1
  while [ ! -e "$target" ]; do target=$(dirname "$target"); done
  for path in "$data1" "$data2"; do
    [ ! -e "$path" ] || [ "$(stat -f %d "$path")" = "$(stat -f %d "$target")" ] || return 1
  done
  mount_point=$(df -P "$target" | awk 'NR == 2 { print $NF }')
  mount | grep -F " on $mount_point (apfs" >/dev/null
}
sources() {
  local name
  for name in "${databases[@]}"; do
    [ ! -f "$data1/userdata/$name" ] || printf '%s\n' "$data1/userdata/$name"
    [ ! -f "$data1/userdata/$name-wal" ] || printf '%s\n' "$data1/userdata/$name-wal"
  done
  for name in "${userdata_entries[@]}"; do [ ! -e "$data1/userdata/$name" ] || printf '%s\n' "$data1/userdata/$name"; done
  for name in "${desktop_entries[@]}"; do [ ! -e "$data2/$name" ] || printf '%s\n' "$data2/$name"; done
}
measure_backup() {
  local path
  for path in "$data1" "$data1/userdata" "$data2"; do [ ! -L "$path" ] || die $E_SAFETY "Refusing symlinked app data: $path"; done
  clone=0
  if can_clone; then clone=1; fi
  data_kb=$(sources | while IFS= read -r path; do size_kb "$path"; done | awk '{ s += $1 } END { print s + 0 }')
  # Clones share blocks with the live data; the headroom covers the WAL checkpoint during verification.
  if [ "$clone" = 1 ]; then backup_kb=524288; else backup_kb=$((data_kb + data_kb / 10 + 524288)); fi
}
backup_label() {
  if [ "$clone" = 1 ]; then printf '%s of app data, APFS clone (almost no extra disk space)' "$(human_kb "$data_kb")"; else printf '%s of app data, full copy' "$(human_kb "$data_kb")"; fi
}
need_space() {
  local available
  available=$(df -Pk "$1" | awk 'NR == 2 { print $4 }')
  [[ $available =~ ^[0-9]+$ ]] || die $E_FAIL "Cannot read free space for $1."
  [ "$available" -ge "$2" ] || die $E_SPACE "Not enough free space for $3: need $(human_kb "$2"), have $(human_kb "$available"). Nothing was changed. Free some space (prune-legacy may help), then run this again."
}
copy() { if [ "$clone" = 1 ]; then cp -c -Rp "$1" "$2"; else cp -Rp "$1" "$2"; fi; }

new_backup() {
  local id
  id=$(date -u +%Y%m%dT%H%M%SZ)
  backup="$root/$id"
  mkdir "$backup" || die $E_FAIL 'A backup with this timestamp already exists; run this again in a second.'
  {
    printf 'format\t%s\nkind\t%s\ncreated\t%s\n' "$backup_format" "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'app-name\t%s\napp-version\t%s\ntarget\t%s\n' "${old##*/}" "$installed_version" "$2"
    printf 'clone\t%s\n' "$([ "$clone" = 1 ] && echo yes || echo no)"
  } >"$backup/manifest"
}
# Runs only while Tx Code is stopped, so each database and its WAL form a consistent pair.
snapshot_data() {
  local name src result
  step 'Backing up app data'
  mkdir "$backup/userdata" "$backup/desktop"
  for name in "${databases[@]}"; do
    src="$data1/userdata/$name"
    [ -f "$src" ] || continue
    if [ "$clone" = 1 ]; then
      cp -c "$src" "$backup/userdata/$name"
      # -shm is a rebuildable index and is not part of the database.
      [ ! -f "$src-wal" ] || cp -c "$src-wal" "$backup/userdata/$name-wal"
    else
      sqlite3 -readonly "$src" "VACUUM INTO '$(sql_string "$backup/userdata/$name")'"
    fi
  done
  for name in "${userdata_entries[@]}"; do [ ! -e "$data1/userdata/$name" ] || copy "$data1/userdata/$name" "$backup/userdata/$name"; done
  for name in "${desktop_entries[@]}"; do [ ! -e "$data2/$name" ] || copy "$data2/$name" "$backup/desktop/$name"; done
  info 'Verifying the backup (reads every database page; large databases take a minute).'
  for name in "${databases[@]}"; do
    [ -f "$backup/userdata/$name" ] || continue
    # The checkpoint folds the copied WAL into the snapshot; Apple's SQLite keeps the emptied files.
    result=$(sqlite3 "$backup/userdata/$name" 'PRAGMA quick_check; PRAGMA wal_checkpoint(TRUNCATE);' 2>&1) || true
    [[ $result == $'ok\n0|'* ]] && [ ! -s "$backup/userdata/$name-wal" ] ||
      die $E_SAFETY "The backup of $name failed SQLite's integrity check (${result%%$'\n'*}). Nothing was installed and your app is unchanged. The live database may be damaged: keep Tx Code closed and investigate before updating."
    rm -f "$backup/userdata/$name-wal" "$backup/userdata/$name-shm"
  done
  date -u +%Y-%m-%dT%H:%M:%SZ >"$backup/complete"
  info "Backup ${backup##*/} verified."
}
restore_data() {
  local from=$1 name
  for name in "${databases[@]}"; do
    rm -f "$data1/userdata/$name" "$data1/userdata/$name-wal" "$data1/userdata/$name-shm" "$data1/userdata/$name-journal"
  done
  mkdir -p "$data1/userdata" "$data2"
  for name in "${databases[@]}" "${userdata_entries[@]}"; do
    rm -rf "${data1:?}/userdata/$name"
    [ ! -e "$from/userdata/$name" ] || copy "$from/userdata/$name" "$data1/userdata/$name"
  done
  for name in "${desktop_entries[@]}"; do
    rm -rf "${data2:?}/$name"
    [ ! -e "$from/desktop/$name" ] || copy "$from/desktop/$name" "$data2/$name"
  done
}
# Moves $stage into place and the previous app into the backup. Renames only; nothing is copied.
swap_in() {
  local destination=$1
  ! is_running || die $E_RUNNING 'Tx Code was opened again before the swap. Quit it and run this again; the app was not replaced.'
  if [ -n "$old" ]; then app_move "$old" "$old.aside"; fi
  if ! app_move "$stage" "$destination"; then
    if [ -n "$old" ]; then app_move "$old.aside" "$old"; fi
    die $E_SAFETY 'Moving the new app into place failed; the previous app was put back.'
  fi
  stage=''
  if [ -n "$old" ]; then
    mkdir -p "$backup/app"
    app_move "$old.aside" "$backup/app/${old##*/}"
  fi
}

# ---- leftovers from interrupted runs ---------------------------------------

take_lock() {
  local lock="$root/.updater-lock" pid
  [ ! -L "$root" ] || die $E_SAFETY "Refusing a symlinked backup folder: $root"
  mkdir -p "$root"
  root=$(cd "$root" && pwd -P)
  lock="$root/.updater-lock"
  if ! mkdir "$lock" 2>/dev/null; then
    pid=$(cat "$lock/pid" 2>/dev/null || true)
    if [[ $pid =~ ^[0-9]+$ ]] && ! kill -0 "$pid" 2>/dev/null; then
      if ! { rm -f "$lock/pid" && rmdir "$lock" && mkdir "$lock"; }; then die $E_SAFETY "Cannot clear the stale lock $lock."; fi
      info 'Cleared the lock of an interrupted run.'
    else
      die $E_SAFETY "Another updater run holds $lock. If none is running, remove that folder and run this again."
    fi
  fi
  locked=1
  printf '%s\n' "$$" >"$lock/pid"
}
recover_aside() {
  local base aside version newest
  for base in "$apps/Tx Code.app" "$apps/Tx Code (Nightly).app"; do
    aside="$base.aside"
    [ -e "$aside" ] || [ -L "$aside" ] || continue
    [ -d "$aside" ] && [ ! -L "$aside" ] || die $E_SAFETY "Unexpected $aside. Move it to the Trash, then run this again."
    if [ ! -e "$apps/Tx Code.app" ] && [ ! -e "$apps/Tx Code (Nightly).app" ]; then
      app_move "$aside" "$base"
      info "Put back ${base##*/} after an interrupted update."
      continue
    fi
    # The new app (possibly under the other name) is in place; only the move into the backup was lost.
    version=$(bundle_version "$aside" || true)
    newest=$(complete_ids | sed -n 1p)
    if [ -n "$version" ] && [ -n "$newest" ] && [ ! -e "$root/$newest/app" ] &&
      [ "$(mget "$newest" app-name)" = "${base##*/}" ] && [ "$(mget "$newest" app-version)" = "$version" ]; then
      mkdir "$root/$newest/app"
      app_move "$aside" "$root/$newest/app/${base##*/}"
      info "Finished an interrupted update: moved the previous app into backup $newest."
    else
      die $E_SAFETY "An interrupted update left $aside next to the installed app. Nothing was changed. Move it to the Trash if you no longer need it, then run this again."
    fi
  done
}
recover_leftovers() {
  local leftover quarantine source
  [ ! -e "$root/.restore-journal.json" ] || die $E_SAFETY "An older version of this updater left an unfinished rollback ($root/.restore-journal.json). Recover it by hand first; nothing was changed."
  if [ -f "$root/.rollback-in-progress" ] && [ "$command" != rollback ]; then
    IFS=$'\t' read -r quarantine source <"$root/.rollback-in-progress"
    die $E_SAFETY "A rollback was interrupted. Run 'rollback $source' to finish it, or 'rollback $quarantine' to return to the state before it."
  fi
  for leftover in "$apps"/.txcode-update.*.app; do
    [ -e "$leftover" ] || [ -L "$leftover" ] || continue
    as_needed rm -rf "$leftover"
    info "Removed leftover staging copy ${leftover##*/}"
  done
  recover_aside
  while IFS= read -r leftover; do
    if is_v3 "$leftover" && [ ! -f "$root/$leftover/complete" ]; then
      remove_backup "$leftover"
      info "Removed incomplete backup $leftover from an earlier run."
    fi
  done < <(backup_ids)
}
legacy_note() {
  local count
  count=$(legacy_ids | awk 'END { print NR }')
  [ "$count" = 0 ] || row Note "$count backup(s) from an older updater use disk space; see prune-legacy."
}

# ---- releases --------------------------------------------------------------

find_release() {
  local file="$tmp/releases.json" rel='' i=0 j=0 name stamp build best_stamp=0 best_build=0 ambiguous=0 sums=0
  if [ -n "$want_tag" ]; then
    fetch -sS "$api/releases/tags/$want_tag" "$file" || die $E_NETWORK "Could not find release $want_tag. Check the tag at $web/releases."
    [ "$(json "$file" draft)" = false ] && [ "$(json "$file" tag_name)" = "$want_tag" ] || die $E_NETWORK "Release $want_tag is not published."
    tag=$want_tag
  else
    fetch -sS "$api/releases?per_page=100" "$file" || die $E_NETWORK 'Could not look up releases on GitHub. Check your connection, then run this again.'
    tag=''
    while name=$(json "$file" "$i.tag_name"); do
      if [[ $name =~ ^v[0-9]+\.[0-9]+\.[0-9]+-nightly\.([0-9]{8})\.([0-9]+)$ ]] &&
        [ "$(json "$file" "$i.draft")" = false ] && [ "$(json "$file" "$i.prerelease")" = true ]; then
        stamp=$((10#${BASH_REMATCH[1]})) build=$((10#${BASH_REMATCH[2]}))
        if [ "$stamp" -gt "$best_stamp" ] || { [ "$stamp" -eq "$best_stamp" ] && [ "$build" -gt "$best_build" ]; }; then
          tag=$name rel="$i." best_stamp=$stamp best_build=$build ambiguous=0
        elif [ "$stamp" -eq "$best_stamp" ] && [ "$build" -eq "$best_build" ]; then
          ambiguous=1
        fi
      fi
      i=$((i + 1))
    done
    [ -n "$tag" ] || die $E_NETWORK 'No published Tx Code nightly was found.'
    [ "$ambiguous" = 0 ] || die $E_SAFETY "Two releases claim to be the newest nightly ($tag). Pick one with --version."
  fi
  release_version=${tag#v}
  archive="Tx-Code-$release_version-$arch.dmg"
  release_date=$(json "$file" "${rel}published_at" || true)
  release_date=${release_date%%T*}
  dmg_size=''
  while name=$(json "$file" "${rel}assets.$j.name"); do
    if [ "$name" = "$archive" ]; then dmg_size=$(json "$file" "${rel}assets.$j.size"); fi
    if [ "$name" = SHA256SUMS ]; then sums=1; fi
    j=$((j + 1))
  done
  if [ -z "$dmg_size" ] || [ "$sums" != 1 ]; then
    [ "$arch" != arm64 ] || die $E_NETWORK "$tag has no $archive. Apple Silicon builds are not published yet."
    die $E_NETWORK "$tag lacks $archive or SHA256SUMS. Try again after the release finishes uploading."
  fi
  [[ $dmg_size =~ ^[0-9]+$ ]] && [ "$dmg_size" -gt 0 ] && [ "$dmg_size" -le 2147483648 ] || die $E_NETWORK 'The release lists an invalid download size.'
}

download_and_mount() {
  local sha actual path id
  need_space "$tmp" $((dmg_size / 1024 + 65536)) 'the download'
  step "Downloading $archive ($(human_kb $((dmg_size / 1024))))"
  if [ -t 2 ]; then
    fetch --progress-bar "$web/releases/download/$tag/$archive" "$tmp/$archive" || die $E_NETWORK 'The download failed. Check your connection, then run this again.'
  else
    fetch -sS "$web/releases/download/$tag/$archive" "$tmp/$archive" || die $E_NETWORK 'The download failed. Check your connection, then run this again.'
  fi
  fetch -sS "$web/releases/download/$tag/SHA256SUMS" "$tmp/SHA256SUMS" || die $E_NETWORK 'Downloading SHA256SUMS failed. Check your connection, then run this again.'
  [ "$(wc -c <"$tmp/$archive" | tr -d ' ')" = "$dmg_size" ] || die $E_NETWORK 'The download is incomplete. Run this again.'
  sha=$(awk -v name="$archive" '$1 ~ /^[0-9a-fA-F]{64}$/ { line = $0; sub(/^[^ ]+[ ]+/, "", line); sub(/^\*/, "", line); if (line == name) { print tolower($1); n++ } } END { if (n != 1) exit 1 }' "$tmp/SHA256SUMS") ||
    die $E_NETWORK "SHA256SUMS has no single entry for $archive."
  actual=$(shasum -a 256 "$tmp/$archive" | cut -d ' ' -f1)
  [ "$sha" = "$actual" ] || die $E_NETWORK 'Checksum mismatch: the download is corrupt or was tampered with. Nothing was changed.'
  info 'Checksum verified.'
  mkdir "$tmp/mount"
  hdiutil attach -readonly -nobrowse -mountpoint "$tmp/mount" "$tmp/$archive" >/dev/null || die $E_SAFETY 'Could not open the disk image.'
  mounted=1
  chosen=''
  while IFS= read -r path; do
    id=$(plist "$path" CFBundleIdentifier) || die $E_SAFETY 'The disk image contains an unreadable app.'
    case "$id" in com.t3tools.t3code | net.coriou.txcode.dev.*) die $E_SAFETY "The disk image contains a forbidden app ($id)." ;; esac
    if [ "$id" = "$bundle_id" ]; then
      [ -z "$chosen" ] || die $E_SAFETY 'The disk image contains more than one Tx Code app.'
      chosen=$path
    fi
  done < <(find "$tmp/mount" -name '*.app' -prune -print)
  [ -n "$chosen" ] || die $E_SAFETY 'The disk image contains no Tx Code app.'
  case "${chosen##*/}" in 'Tx Code.app' | 'Tx Code (Nightly).app') ;; *) die $E_SAFETY "Unexpected app name ${chosen##*/}." ;; esac
  identity "$chosen" "$release_version" || die $E_SAFETY "The app in the disk image is not a valid Tx Code $release_version build for this Mac."
}

# ---- commands --------------------------------------------------------------

run_update() {
  if [ "$mutating" = 1 ]; then
    take_lock
    recover_leftovers
  fi
  find_app
  find_release
  if [ "$installed_version" = "$release_version" ] && [ "$force" = 0 ]; then
    success "Already up to date ($release_version)."
    exit 0
  fi
  measure_backup
  printf '%sTx Code update%s\n' "$c_bold" "$c_off"
  row Installed "${installed_version:-not installed}"
  row Available "$release_version${release_date:+ (released $release_date)}"
  row Download "$(human_kb $((dmg_size / 1024)))"
  row Backup "$(backup_label)"
  legacy_note
  if [ "$dry_run" = 1 ]; then
    success 'Dry run: would download, verify, quit Tx Code, back up, install and reopen. Nothing was changed.'
    exit 0
  fi
  ask "Install $release_version?" y || die $E_CANCEL 'Cancelled. Nothing was changed.'
  download_and_mount
  app_kb=$(size_kb "$chosen")
  need_space "$root" $((backup_kb + app_kb)) 'the backup and the new app'
  need_space "$apps" $((app_kb + 65536)) 'the new app'
  ensure_stopped
  new_backup update "$release_version"
  snapshot_data
  step "Installing $release_version"
  destination="$apps/${chosen##*/}"
  stage="$apps/.txcode-update.${tmp##*/}.app"
  if [ -w "$apps" ]; then
    ditto "$chosen" "$stage" || die $E_FAIL 'Copying the new app failed. Nothing was replaced.'
  else
    ditto "$chosen" "$tmp/staged.app" || die $E_FAIL 'Copying the new app failed. Nothing was replaced.'
    app_move "$tmp/staged.app" "$stage"
  fi
  identity "$stage" "$release_version" || die $E_SAFETY 'The copied app failed its identity check. Nothing was replaced.'
  swap_in "$destination"
  prune ''
  step 'Opening Tx Code'
  open "$destination" || die $E_FAIL "Installed $release_version, but macOS could not open it. Open $destination yourself; backup ${backup##*/} is kept."
  success "Updated ${installed_version:-Tx Code} -> $release_version. Backup: ${backup##*/}"
}

run_status() {
  local id app_version kind label
  find_app
  row Installed "${installed_version:-not installed}${old:+ ($old)}"
  local latest
  if latest=$(find_release >/dev/null 2>&1 && printf '%s\t%s' "$release_version" "$release_date"); then
    IFS=$'\t' read -r release_version release_date <<<"$latest"
    if [ "$release_version" = "$installed_version" ]; then label='up to date'; else label='update available'; fi
    row Latest "$release_version${release_date:+ (released $release_date)}, $label"
  else
    row Latest 'unavailable (could not reach GitHub)'
  fi
  row Backups "$root"
  while IFS= read -r id; do
    app_version=$(mget "$id" app-version)
    kind=$(mget "$id" kind)
    label="$(human_kb "$(size_kb "$root/$id")")"
    [ "$(mget "$id" clone)" != yes ] || label="$label, cloned"
    [ -d "$root/$id/app" ] || label="$label, data only"
    printf '    %s  %-8s app %-32s %s\n' "$id" "$kind" "${app_version:-none}" "$label"
  done < <(complete_ids)
  [ -n "$(complete_ids)" ] || info 'No backups yet.'
  legacy_note
}

run_rollback() {
  local ids count choice source_dir target_name target_version has_app=0 index=0 id app_kb
  if [ "$mutating" = 1 ]; then
    take_lock
    recover_leftovers
  fi
  ids=$(complete_ids)
  [ -n "$ids" ] || die $E_FAIL 'There are no backups to roll back to.'
  if [ -z "$rollback_id" ]; then
    [ "$yes" = 0 ] && [ -t 0 ] || die $E_USAGE 'Name the backup to restore: rollback <ID>. See status for IDs.'
    count=$(printf '%s\n' "$ids" | awk 'END { print NR }')
    while IFS= read -r id; do
      index=$((index + 1))
      printf '  %d) %s  app %s\n' "$index" "$id" "$(mget "$id" app-version)"
    done <<<"$ids"
    printf 'Restore which backup? [1-%s, Enter to cancel] ' "$count"
    IFS= read -r choice || choice=''
    [[ $choice =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "$count" ] || die $E_CANCEL 'Cancelled. Nothing was changed.'
    rollback_id=$(printf '%s\n' "$ids" | sed -n "${choice}p")
  fi
  is_complete "$rollback_id" || die $E_USAGE "No complete backup named $rollback_id. See status."
  source_dir="$root/$rollback_id"
  target_name=$(mget "$rollback_id" app-name)
  target_version=$(mget "$rollback_id" app-version)
  find_app
  if [ -n "$target_name" ] && [ -d "$source_dir/app/$target_name" ]; then
    has_app=1
    identity "$source_dir/app/$target_name" "$target_version" || die $E_SAFETY "The app in backup $rollback_id failed its identity check."
  elif [ -z "$target_version" ] || [ "$installed_version" != "$target_version" ]; then
    die $E_SAFETY "Backup $rollback_id holds data for app ${target_version:-none} but no app copy, and ${installed_version:-no app} is installed. Install that version first, then roll back."
  fi
  measure_backup
  printf '%sTx Code rollback%s\n' "$c_bold" "$c_off"
  row Restore "backup $rollback_id: $([ "$has_app" = 1 ] && echo "app $target_version and its data" || echo 'data only')"
  row Current "${installed_version:-not installed}; backed up first so you can undo"
  row Backup "$(backup_label)"
  if [ "$dry_run" = 1 ]; then
    success 'Dry run: would quit Tx Code, back up the current state and restore that backup. Nothing was changed.'
    exit 0
  fi
  ask "Roll back to $target_version from $rollback_id?" n || die $E_CANCEL 'Cancelled. Nothing was changed.'
  app_kb=0
  if [ "$has_app" = 1 ]; then app_kb=$(size_kb "$source_dir/app"); fi
  need_space "$root" $((backup_kb + app_kb)) 'the safety backup'
  ensure_stopped
  new_backup rollback "$rollback_id"
  snapshot_data
  printf '%s\t%s\n' "${backup##*/}" "$rollback_id" >"$root/.rollback-in-progress"
  step "Restoring data from $rollback_id"
  restore_data "$source_dir"
  if [ "$has_app" = 1 ]; then
    step "Restoring app $target_version"
    stage="$apps/.txcode-update.${tmp##*/}.app"
    as_needed cp -c -Rp "$source_dir/app/$target_name" "$stage"
    identity "$stage" "$target_version" || die $E_SAFETY 'The restored app copy failed its identity check.'
    swap_in "$apps/$target_name"
  fi
  rm -f "$root/.rollback-in-progress"
  prune "$rollback_id"
  success "Rolled back to $target_version. The previous state is backup ${backup##*/}; roll back to it to undo."
  info 'Tx Code was left closed. Open it when ready; worktree files were not changed.'
}

run_prune_legacy() {
  local ids id total=0 kb label
  if [ "$mutating" = 1 ]; then take_lock; fi
  ids=$(legacy_ids)
  if [ -z "$ids" ]; then
    success 'No legacy backups.'
    exit 0
  fi
  printf '%sBackups from older versions of this updater (rollback cannot use them):%s\n' "$c_bold" "$c_off"
  while IFS= read -r id; do
    kb=$(size_kb "$root/$id")
    total=$((total + kb))
    label=$(human_kb "$kb")
    [ -f "$root/$id/complete" ] || label="$label, incomplete"
    printf '  %s  %s\n' "$id" "$label"
  done <<<"$ids"
  if [ "$dry_run" = 1 ]; then
    success "Dry run: would delete $(human_kb "$total"). Nothing was changed."
    exit 0
  fi
  ask "Delete them and free $(human_kb "$total")?" n || die $E_CANCEL 'Cancelled. Nothing was deleted.'
  while IFS= read -r id; do remove_backup "$id"; done <<<"$ids"
  success "Deleted. Freed $(human_kb "$total")."
}

case $command in
  update) run_update ;;
  status) run_status ;;
  rollback) run_rollback ;;
  prune-legacy) run_prune_legacy ;;
esac
