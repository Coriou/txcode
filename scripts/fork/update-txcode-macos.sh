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
The newest complete scoped snapshot is kept; legacy and incomplete backups are retained.
Version 2 backups contain application state and the previous app. Workspace files
stay at their current paths and are not backed up or rolled back. Python 3 is
required. Rollback quarantines current state first and stays stopped for review.
Legacy full-profile snapshots cannot be restored automatically by this updater.
Manual recovery needs a separate scoped conversion. An interrupted swap renames the previous
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
command -v python3 >/dev/null 2>&1 || fail 'Python 3 is required for safe application-state backups. Install Python 3, then run this script again. Nothing has been downloaded or changed.'
state() {
  TXCODE_STATE_APPS="$apps" TXCODE_STATE_BACKUPS="$root" python3 - "$@" <<'TXCODE_STATE_PY'
import json, os, pathlib, sqlite3, stat, subprocess, sys, time
from urllib.parse import quote

# Fork-only application-state snapshots; repository files are never restored.
def die(message):
    raise RuntimeError(message)

def load(path):
    if not path.exists(): return {}
    if path.is_symlink(): die('Settings symlink refused: ' + str(path))
    value = json.loads(path.read_text())
    if not isinstance(value, dict): die('Settings must be a JSON object: ' + str(path))
    return value

def write(path, value):
    temporary = path.with_name(path.name + '.writing')
    with temporary.open('x') as f:
        json.dump(value, f, indent=2); f.write('\n'); f.flush(); os.fsync(f.fileno())
    temporary.replace(path)
    descriptor = os.open(path.parent, os.O_RDONLY)
    try: os.fsync(descriptor)
    finally: os.close(descriptor)

def inside(path, parent):
    return path == parent or parent in path.parents

def guard_mutable_roots(paths, profile):
    roots = [profile.parent / 'Library/Application Support/txcode-v2', pathlib.Path(os.environ.get('TXCODE_STATE_APPS', '/Applications'))]
    if os.environ.get('TXCODE_STATE_BACKUPS'): roots.append(pathlib.Path(os.environ['TXCODE_STATE_BACKUPS']))
    for value in paths:
        workspace = pathlib.Path(value).resolve()
        for root in roots:
            target = root.resolve()
            if inside(workspace, target) or inside(target, workspace):
                die('Workspace overlaps updater-managed path: ' + str(root) + '. Keep current files in place and obtain a scoped recovery review; no automatic replacement is safe.')

def application_databases(profile):
    # V2 imports state.sqlite when missing; older installed apps still use it directly.
    for name in ('state.sqlite', 'statev2.sqlite'):
        db = profile / 'userdata' / name
        if db.is_symlink(): die('Database symlink refused: ' + str(db))
        if not db.exists(): continue
        with sqlite3.connect('file:' + quote(str(db)) + '?mode=ro', uri=True) as connection:
            tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
            if tables and 'projection_projects' not in tables:
                die('Unsupported application database schema: ' + str(db) + '. Obtain an offline recovery review before proceeding.')
            yield connection, tables

def inventory(profile, logical_profile=None):
    logical_profile = logical_profile or profile
    if profile.is_symlink(): die('Profile symlink refused')
    if (profile / 'userdata').is_symlink(): die('Userdata symlink refused')
    settings = load(profile / 'userdata/settings.json')
    roots = [str(logical_profile / 'worktrees')]
    roots += [settings.get('worktreesDirectory', '')] + settings.get('previousWorktreesDirectories', [])
    paths = set()
    for value in roots:
        if not isinstance(value, str): die('Invalid workspace directory setting')
        if value:
            value = value.replace('~/', str(logical_profile.parent) + '/', 1) if value.startswith('~/') else value
            p = pathlib.Path(value)
            if p.is_absolute(): paths.add(str(p))
    for connection, tables in application_databases(profile):
        if 'projection_projects' in tables:
            paths.update(row[0] for row in connection.execute('SELECT workspace_root FROM projection_projects') if row[0])
        if 'orchestration_v2_projection_threads' in tables:
            for row in connection.execute('SELECT payload_json FROM orchestration_v2_projection_threads'):
                value = json.loads(row[0]).get('worktreePath')
                if value: paths.add(value)
        if 'projection_threads' in tables:
            paths.update(row[0] for row in connection.execute('SELECT worktree_path FROM projection_threads') if row[0])
    if any(not isinstance(p, str) or not pathlib.Path(p).is_absolute() for p in paths):
        die('Unsupported workspace location in application database')
    guard_mutable_roots(paths, logical_profile)
    return sorted(paths)

def entries(profile, paths):
    if profile.is_symlink(): die('Profile symlink refused')
    result = []
    for child in sorted(profile.iterdir()) if profile.exists() else []:
        if '\n' in child.name or '\t' in child.name: die('Unsupported newline or tab in profile entry')
        real = child.resolve()
        overlaps = any(inside(pathlib.Path(p).resolve(), real) or inside(real, pathlib.Path(p).resolve()) for p in paths)
        if overlaps:
            if child.name == 'userdata': die('Workspace overlaps application userdata; cannot safely snapshot')
            print('Workspace retained in place: ' + str(child), file=sys.stderr)
            continue
        result.append(child.name)
    return result

def copy(source, destination):
    if source.is_symlink():
        destination.symlink_to(os.readlink(source))
        return
    subprocess.run(['ditto', str(source), str(destination)], check=True)

def databases(profile):
    for directory, dirs, files in os.walk(profile, followlinks=False):
        for name in files:
            source = pathlib.Path(directory) / name
            if source.is_symlink(): continue
            if not stat.S_ISREG(source.stat().st_mode): die('Non-regular userdata file refused: ' + str(source))
            with source.open('rb') as f: header = f.read(16)
            if header == b'SQLite format 3\x00': yield source

def snapshot(profile, target):
    paths = inventory(profile)
    names = entries(profile, paths)
    target.mkdir()
    for name in names: copy(profile / name, target / name)
    # SQLite's backup API includes committed WAL data in one consistent database.
    for source in databases(profile / 'userdata'):
        relative = source.relative_to(profile)
        saved = target / relative
        for suffix in ['', '-wal', '-shm', '-journal']:
            path = pathlib.Path(str(saved) + suffix)
            if path.exists(): path.unlink()
        with sqlite3.connect('file:' + quote(str(source)) + '?mode=ro', uri=True) as original:
            with sqlite3.connect(saved) as backup:
                deadline = time.monotonic() + 30
                def progress(status, remaining, total):
                    if time.monotonic() > deadline: die('SQLite snapshot timed out; keep all profile writers stopped')
                original.backup(backup, pages=256, progress=progress)
                if backup.execute('PRAGMA quick_check').fetchall() != [('ok',)]: die('SQLite integrity check failed')
    return {'version': 2, 'scope': 'application-state; workspaces retained in place', 'entries': names, 'workspaces': paths}

def validate(snapshot_dir, profile):
    info = load(snapshot_dir / 'APPLICATION-STATE.json')
    if info.get('version') != 2 or not isinstance(info.get('entries'), list) or not isinstance(info.get('workspaces'), list): die('Invalid application-state manifest')
    if {p.name for p in (snapshot_dir / 'profile').iterdir()} != set(info['entries']): die('Snapshot profile contents do not match scope manifest')
    expected = set(inventory(snapshot_dir / 'profile', profile))
    if not expected.issubset(set(info['workspaces'])): die('Workspace references missing from manifest')
    guard_mutable_roots(info['workspaces'], profile)
    if len(info['entries']) != len(set(info['entries'])): die('Duplicate state entry')
    for workspace in info['workspaces']:
        if not isinstance(workspace, str) or not pathlib.Path(workspace).is_absolute(): die('Invalid workspace reference')
    for name in info['entries']:
        if not isinstance(name, str) or pathlib.Path(name).name != name or name in ('.', '..', 'worktrees'): die('Invalid state entry')
        p = snapshot_dir / 'profile' / name
        if not p.exists() and not p.is_symlink(): die('Missing state entry: ' + name)
        for workspace in info['workspaces']:
            if not isinstance(workspace, str) or not pathlib.Path(workspace).is_absolute(): die('Invalid workspace reference')
            if inside(pathlib.Path(workspace).resolve(), (profile / name).resolve()): die('State entry overlaps workspace')
    for db in databases(snapshot_dir / 'profile/userdata'):
        with sqlite3.connect('file:' + quote(str(db)) + '?mode=ro', uri=True) as connection:
            if connection.execute('PRAGMA quick_check').fetchall() != [('ok',)]: die('Snapshot SQLite integrity check failed')
    return info

def safe_to_restore(profile):
    for connection, tables in application_databases(profile):
        checks = [('scheduled_tasks', "enabled != 0"), ('orchestration_v2_effect_outbox', "status IN ('pending', 'running')")]
        for table, predicate in checks:
            if table in tables and connection.execute('SELECT 1 FROM ' + table + ' WHERE ' + predicate + ' LIMIT 1').fetchone():
                die('Snapshot contains enabled schedules or pending effects. Automatic rollback is blocked before changing current state. Choose a quiescent snapshot or obtain an offline recovery review; do not launch this snapshot against current workspaces.')

def disable_cleanup(profile):
    path = profile / 'userdata/settings.json'
    path.parent.mkdir(parents=True, exist_ok=True)
    settings = load(path)
    settings['continueThreadsAfterServerUpdate'] = False
    settings['worktreeCleanup'] = {'mode': 'off'}
    settings.update(worktreeAfterDays=None, worktreeSettledAfterDays=None, worktreeOnMerge=False, worktreeOnDelete=False, worktreeUnchanged=False)
    overrides = settings.get('projectSettingsOverrides', {})
    if not isinstance(overrides, dict): die('Invalid project settings overrides')
    for override in overrides.values():
        if not isinstance(override, dict): die('Invalid project settings override')
        override['continueThreadsAfterServerUpdate'] = False
        override['worktreeCleanup'] = {'mode': 'off'}
    settings['projectSettingsOverrides'] = overrides
    write(path, settings)

def report(info):
    for value in info['workspaces']:
        path = pathlib.Path(value)
        if not path.is_dir(): print('WARNING: missing workspace (not recreated): ' + value)
        else:
            result = subprocess.run(['git', '-C', value, 'for-each-ref', '--format=%(refname)', 'refs/t3/orchestration-v2/checkpoints'], capture_output=True, text=True)
            if result.returncode or not result.stdout.strip(): print('WARNING: no checkpoint refs available: ' + value)

try:
    operation, profile_arg, backup_arg = sys.argv[1:4]
    profile, backup = pathlib.Path(profile_arg), pathlib.Path(backup_arg)
    if operation == 'plan':
        for name in entries(profile, inventory(profile)): print(str(profile / name))
    elif operation == 'snapshot':
        write(backup / 'APPLICATION-STATE.json', snapshot(profile, backup / 'profile'))
    elif operation == 'verify': validate(backup, profile)
    elif operation == 'validate':
        report(validate(backup, profile))
        safe_to_restore(backup / 'profile')
    elif operation == 'check-work': safe_to_restore(backup / 'profile')
    elif operation == 'stage':
        info = validate(backup, profile)
        safe_to_restore(backup / 'profile')
        stage = pathlib.Path(sys.argv[4]) / 'restore-stage'
        copy(backup / 'profile', stage)
        disable_cleanup(stage)
        print('Automatic worktree cleanup is disabled after rollback. Reconcile surviving workspaces before enabling it again.')
    elif operation == 'restore':
        selected = pathlib.Path(sys.argv[4])
        info = validate(selected, profile)
        stage = backup / 'restore-stage'
        names = sorted(set(info['entries']) | set(entries(profile, inventory(profile) + info['workspaces'])))
        # Neither old metadata nor current metadata may authorize moving a workspace.
        protected = inventory(profile) + info['workspaces']
        for name in names:
            if any(inside(pathlib.Path(p).resolve(), (profile / name).resolve()) or inside((profile / name).resolve(), pathlib.Path(p).resolve()) for p in protected):
                die('Restore entry overlaps surviving workspace: ' + name)
        journal = backup.parent / '.restore-journal.json'
        displaced = backup / 'displaced-profile'
        displaced.mkdir()
        write(journal, {'backup': backup.name, 'entries': names, 'present': [n for n in names if (profile / n).exists() or (profile / n).is_symlink()], 'desktopPresent': (profile.parent / 'Library/Application Support/txcode-v2').exists(), 'appOriginal': sys.argv[5] if len(sys.argv) > 5 else '', 'appDestination': sys.argv[6] if len(sys.argv) > 6 else ''})
        profile.mkdir(parents=True, exist_ok=True)
        for name in names:
            source = profile / name
            if source.exists() or source.is_symlink(): source.rename(displaced / name)
            if (stage / name).exists() or (stage / name).is_symlink(): (stage / name).rename(source)
    elif operation == 'journal':
        value = load(backup / '.restore-journal.json')
        allowed = {str(pathlib.Path(sys.argv[4]) / name) for name in ('Tx Code.app', 'Tx Code (Nightly).app')}
        if value.get('appOriginal') not in allowed | {''} or value.get('appDestination') not in allowed: die('Restore journal lacks safe app recovery paths; keep the app stopped for an offline recovery review')
        print(value['backup']); print(value['appOriginal']); print(value['appDestination'])
    elif operation == 'recover-data':
        journal = backup / '.restore-journal.json'
        if journal.exists():
            value = load(journal)
            identifier = value['backup']
            if not isinstance(identifier, str) or len(identifier) != 16 or not identifier.endswith('Z') or not identifier[:8].isdigit() or not identifier[9:15].isdigit(): die('Invalid restore journal')
            quarantine = backup / identifier
            if quarantine.is_symlink(): die('Quarantine symlink refused')
            rejected = quarantine / 'interrupted-restore'
            rejected.mkdir(exist_ok=True)
            for name in value['entries']:
                if pathlib.Path(name).name != name or name in ('.', '..', 'worktrees'): die('Invalid restore journal entry')
                source = profile / name
                previous = quarantine / 'displaced-profile' / name
                if previous.exists() or previous.is_symlink():
                    if source.exists() or source.is_symlink(): source.rename(rejected / name)
                    previous.rename(source)
                elif name not in value['present'] and (source.exists() or source.is_symlink()): source.rename(rejected / name)
            desktop = profile.parent / 'Library/Application Support/txcode-v2'
            previous_desktop = quarantine / 'displaced/desktop'
            if previous_desktop.exists():
                if desktop.exists(): desktop.rename(quarantine / 'interrupted-desktop')
                previous_desktop.rename(desktop)
            elif not value.get('desktopPresent', False) and desktop.exists(): desktop.rename(quarantine / 'interrupted-desktop')
            print('Recovered application state; journal retained until app recovery completes.')
    elif operation == 'finish':
        (backup.parent / '.restore-journal.json').unlink()
        descriptor = os.open(backup.parent, os.O_RDONLY)
        try: os.fsync(descriptor)
        finally: os.close(descriptor)
    else: die('Unknown state operation')
except Exception as error:
    print('Tx Code updater: ' + str(error), file=sys.stderr)
    sys.exit(1)
TXCODE_STATE_PY
}
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
  if [ -n "${backup:-}" ] && [ -d "$backup" ] && [ ! -f "$backup/complete" ]; then
    printf 'Incomplete backup retained at %s; not eligible for rollback.\n' "$backup" >&2
  fi
  discard_download || true
  if [ "$mounted" = 0 ]; then remove_workdir || true; fi
  if [ "${locked:-0}" = 1 ]; then rmdir "$root/.updater-lock" || true; fi
  exit "$exit_status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
get() { curl -fLsS --connect-timeout 15 --max-time 900 --max-filesize 2147483648 -H 'User-Agent: Tx-Code-macOS-updater' "$1" -o "$2"; }
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
    [ -f "$child/complete" ] && [ ! -L "$child/complete" ] || fail 'Invalid complete marker.'
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
    $1=="format" {if($2!="application-state-v2" || keys[$1]++) bad=1; next}
    $1 ~ /^(tag|sha256|bundle-id|version|arch|commit)$/ {if(keys[$1]++) bad=1; next}
    {bad=1}
    END {if(apps>1 || !keys["tag"] || !keys["sha256"] || !keys["bundle-id"] || !keys["version"] || !keys["arch"] || !keys["commit"]) bad=1; exit bad}' "$manifest" || fail 'Invalid manifest or forbidden source path.'
}
prune_plan() {
  complete_ids > "$tmp/complete-list" || fail 'Cannot enumerate safe backups.'
  # The snapshot about to be written is the one complete backup that is kept.
  sed -n '1,$p' "$tmp/complete-list" > "$tmp/prune-list"
  while IFS= read -r id; do
    validate_manifest "$root/$id/BACKUP-MANIFEST.txt"
    if ! grep -q '^format' "$root/$id/BACKUP-MANIFEST.txt"; then
      printf 'Keeping legacy full-profile snapshot %s (manual recovery only)\n' "$root/$id"
      continue
    fi
    [ ! -e "$root/$id/restore-in-progress" ] || continue
    state verify "$data1" "$root/$id" || fail 'Invalid snapshot; nothing pruned.'
    printf 'Retention would remove %s (%s)\n' "$root/$id" "$(size "$root/$id")"
  done < "$tmp/prune-list"
}
prune() {
  complete_ids > "$tmp/complete-list" || fail 'Cannot enumerate safe backups.'
  kept_scoped=0
  while IFS= read -r id; do
    valid_child "$id"
    validate_manifest "$root/$id/BACKUP-MANIFEST.txt"
    if ! grep -q '^format' "$root/$id/BACKUP-MANIFEST.txt"; then continue; fi
    [ ! -e "$root/$id/restore-in-progress" ] || continue
    state verify "$data1" "$root/$id" || fail 'Invalid snapshot; retained.'
    if [ "$kept_scoped" = 0 ]; then kept_scoped=1; continue; fi
    printf 'Removing backup %s (%s)\n' "$root/$id" "$(size "$root/$id")"
    rm -rf "$root/$id"
  done < "$tmp/complete-list"
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
profile_plan() {
  state plan "$data1" "$root" > "$tmp/profile-paths" || fail 'Cannot safely determine application-state scope.'
}
profile_space() {
  profile_plan
  set -- "$@"
  while IFS= read -r source; do set -- "$@" "$source"; done < "$tmp/profile-paths"
  space_preflight "$@"
}
# Reserve full copies plus headroom; never count retention as available space.
space_preflight() {
  required=1048576
  for source in "$@"; do
    [ -n "$source" ] && [ -e "$source" ] || continue
    usage=$(du -Ask "$source") || fail "Cannot measure $source"
    kb=$(printf '%s\n' "$usage" | awk 'NR==1 {print $1}')
    case "$kb" in ''|*[!0-9]*) fail 'Invalid source size.' ;; esac
    required=$((required + kb + kb / 5))
  done
  for volume in "$root" "$apps" "$tmp" "$(dirname "$data1")" "$(dirname "$data2")"; do
    available=$(df -Pk "$volume") || fail "Cannot inspect free space: $volume"
    available=$(printf '%s\n' "$available" | awk 'NR==2 {print $4}')
    case "$available" in ''|*[!0-9]*) fail 'Invalid free-space result.' ;; esac
    [ "$available" -ge "$required" ] || fail "Insufficient free space on $volume: need $required KiB including headroom, available $available KiB. No backup started; nothing pruned."
  done
}
recover_transaction() {
  [ -e "$root/.restore-journal.json" ] || [ -L "$root/.restore-journal.json" ] || return 0
  state journal "$data1" "$root" "$apps" > "$tmp/recovery-paths" || fail 'Interrupted rollback needs an offline recovery review; journal retained.'
  recovery_id=$(sed -n '1p' "$tmp/recovery-paths")
  original_app=$(sed -n '2p' "$tmp/recovery-paths")
  restored_app=$(sed -n '3p' "$tmp/recovery-paths")
  valid_child "$recovery_id"
  quarantine="$root/$recovery_id"
  validate_manifest "$quarantine/BACKUP-MANIFEST.txt"
  recorded_original=$(awk -F '\t' -v a="$apps/Tx Code.app" -v b="$apps/Tx Code (Nightly).app" '$1=="source" && ($2==a || $2==b) {print $2}' "$quarantine/BACKUP-MANIFEST.txt")
  [ "$original_app" = "$recorded_original" ] || fail 'App recovery paths do not match quarantine manifest; journal retained.'
  recovery_stage="$apps/.txcode-update.recovery.$recovery_id.app"
  attempt=$(mktemp -d "$quarantine/app-recovery.XXXXXXXX") || fail 'Cannot prepare app recovery; journal retained.'
  original_aside=
  if [ -n "$original_app" ]; then
    original_aside=$(aside_path "$original_app")
    original_version=$(awk -F '\t' '$1=="version" {print $2}' "$quarantine/BACKUP-MANIFEST.txt")
    identity "$quarantine/${original_app##*/}" "$original_version" || fail 'Original quarantined app failed validation; journal retained.'
    space_preflight "$quarantine/${original_app##*/}"
    ditto "$quarantine/${original_app##*/}" "$tmp/recovery.app" || fail 'Cannot stage original app; journal retained.'
  fi
  if [ -e "$recovery_stage" ] || [ -L "$recovery_stage" ]; then
    [ ! -L "$recovery_stage" ] || fail 'Recovery staging symlink refused; journal retained.'
    app_move "$recovery_stage" "$attempt/${recovery_stage##*/}" || fail 'Cannot quarantine previous recovery staging; journal retained.'
  fi
  if [ -n "$original_app" ]; then
    app_move "$tmp/recovery.app" "$recovery_stage" || fail 'Original app staging interrupted; journal retained.'
    identity "$recovery_stage" "$original_version" || fail 'Staged recovery app validation failed; journal retained.'
  fi
  state recover-data "$data1" "$root" || fail 'Application-state recovery interrupted; journal retained.'
  for candidate in "$restored_app" "$original_app" "$original_aside"; do
    [ -n "$candidate" ] || continue
    if [ -e "$candidate" ] || [ -L "$candidate" ]; then
      [ ! -L "$candidate" ] || fail 'App recovery symlink refused; journal retained.'
      identity "$candidate" '' || fail 'Unexpected app during recovery; journal retained.'
      app_move "$candidate" "$attempt/${candidate##*/}" || fail 'Cannot quarantine interrupted app; journal retained.'
    fi
  done
  if [ -n "$original_app" ]; then
    app_move "$recovery_stage" "$original_app" || fail 'Original app recovery interrupted; journal retained.'
    identity "$original_app" "$original_version" || fail 'Recovered app validation failed; journal retained.'
  fi
  state finish "$data1" "$quarantine"
  fail "Recovered original app and application state after interrupted rollback. Quarantine retained at $quarantine. Nothing launched; inspect before running the updater again."
}
prepare_root
mkdir "$root/.updater-lock" || fail "Another updater or interrupted run owns $root/.updater-lock. Verify no updater is running before removing this empty lock directory."
locked=1
not_running
profile_plan
recover_transaction
clear_stage
recover_aside
find_old

# version and commit describe the backed-up app. tag and sha256 name the release that replaced it.
manifest() {
  printf 'tag\t%s\nsha256\t%s\nbundle-id\t%s\nversion\t%s\narch\t%s\ncommit\t%s\n' "$tag" "$sha" "$snap_bid" "$snap_version" "$machine" "$snap_commit" > "$backup/BACKUP-MANIFEST.txt"
  printf 'format\tapplication-state-v2\n' >> "$backup/BACKUP-MANIFEST.txt"
  for source in "$data1" "$data2" "$old"; do
    [ -n "$source" ] || continue
    [ ! -e "$source" ] || printf 'source\t%s\n' "$source" >> "$backup/BACKUP-MANIFEST.txt"
  done
}
launch() {
  printf 'Installed: %s\nBackup: %s\n' "$destination" "$backup"
  printf '%s\n' 'On the first launch of a build that contains migration 066, Tx Code rewrites some historical thread settlement timestamps in ~/.txcode from app versions 0.0.35 through 0.0.38. Putting the old app back does not undo that rewrite. Rollback restores the data backup taken before the swap. Official T3 profiles are not touched.'
  if [ "$command" = rollback ]; then
    printf '%s\n' 'Rollback is installed and remains stopped. Reconcile workspaces, pending work and schedules before manually opening Tx Code. Workspace files are current; restored conversation history may be older. Automatic worktree cleanup remains disabled until you enable it again.'
    return
  fi
  if confirm "Launch $destination?"; then
    open "$destination" || fail "Launch request failed; the installed app and backup were kept. Try opening $destination manually."
    printf 'Launch requested; application health has not been checked.\n'
  else
    printf 'Not launched.\n'
  fi
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
  if ! grep -q '^format' "$snapshot/BACKUP-MANIFEST.txt"; then
    fail "Legacy full-profile rollback requires offline scoped conversion. This updater cannot safely restore old full-profile snapshots automatically and does not implement conversion. Snapshot retained at $snapshot. Current state is unchanged. Keep the artifact for a separate scoped recovery that preserves current workspace files."
  fi
  state validate "$data1" "$snapshot" || fail 'Application-state snapshot validation failed.'
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
  confirm "Restore $selected application state and app? Current contents will be quarantined; workspace files stay current." || fail 'Aborted.'
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
  profile_space "$data2" "$old" "$snapshot"
  new_backup
  manifest
  state snapshot "$data1" "$backup"
  [ ! -e "$data2" ] || ditto "$data2" "$backup/desktop"
  [ -z "$old" ] || ditto "$old" "$backup/${old##*/}"
  not_running
  touch "$backup/restore-in-progress"
  state verify "$data1" "$backup"
  touch "$backup/complete"
  state stage "$data1" "$snapshot" "$backup" || fail 'Cannot prepare safe restored settings; current state is unchanged.'
  state restore "$data1" "$backup" "$snapshot" "$old" "$destination" || fail 'Restore interrupted; rerun after verifying the updater is stopped to recover the quarantined application state.'
  mkdir "$backup/displaced"
  [ ! -e "$data2" ] || mv "$data2" "$backup/displaced/desktop"
  if [ -d "$snapshot/desktop" ]; then ditto "$snapshot/desktop" "$data2" || fail 'Desktop restore failed; quarantine retained.'; fi
  stage="$apps/.txcode-update.${tmp##*/}.app"
  ditto "$snapshot/${destination##*/}" "$tmp/restored.app"
  app_move "$tmp/restored.app" "$stage"
  identity "$stage" '' || fail 'Restored app identity failed.'
  if [ -n "$old" ]; then app_move "$old" "$(aside_path "$old")"; fi
  app_move "$stage" "$destination" || fail 'App restore interrupted; quarantine and aside retained.'
  identity "$destination" '' || fail 'Restored app identity failed; quarantine and aside retained.'
  if [ -n "$old" ]; then app_move "$(aside_path "$old")" "$backup/displaced/${old##*/}"; fi
  state finish "$data1" "$backup"
  rm "$backup/restore-in-progress"
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
[ ! -L "$data2" ] || fail "Source symlink refused: $data2"
profile_plan
set -- "$data2" "$old"
while IFS= read -r source; do set -- "$@" "$source"; done < "$tmp/profile-paths"
for source in "$@"; do
  [ -n "$source" ] || continue
  if [ -e "$source" ]; then
    printf 'Backup: %s (%s)\n' "$source" "$(size "$source")"
  else printf 'Absent (fresh install): %s\n' "$source"; fi
done
prune_plan
confirm 'Back up these paths and swap the app?' || fail 'Aborted.'
not_running
recover_aside
find_old
profile_space "$data2" "$old" "$chosen"
new_backup
snap_bid=none
snap_version=none
snap_commit=none
if [ -n "$old" ]; then read_snapshot "$old"; fi
manifest
state snapshot "$data1" "$backup"
[ ! -e "$data2" ] || ditto "$data2" "$backup/desktop"
not_running
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
not_running
state verify "$data1" "$backup"
touch "$backup/complete"
prune
launch
