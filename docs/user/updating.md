# Updating Tx Code

## Tx Code updates are manual

This fork currently supports manual updates only. **Settings → Environments**
shows the installed server version and manual update guidance. Unsupported server
updates are excluded from **Update everything**; provider updates remain available.
Older environments whose distribution is unknown also need manual guidance from
their maintainer. Protocol incompatibility notices still require updating the
side named in the notice.

For the macOS fork, use the [fork releases](https://github.com/Coriou/txcode/releases)
and the [manual updater instructions](https://github.com/Coriou/txcode/blob/main/scripts/fork/update-txcode-macos.sh).
Finish active work on the desktop and its remote clients, quit the app with
Cmd+Q, then run your local copy of the updater from Terminal. Stop any separately
running service through its normal service controls before replacing it. Follow
the updater's backup, replacement, and launch confirmations. Keep the recorded
backup for recovery. Python 3 is required; the script checks for it before any
release download and never installs prerequisites itself.

New backups use version 2 application-state snapshots: userdata (including the
SQLite databases, secrets, attachments, settings, themes and browser artifacts),
desktop state, the previous app, and unknown profile content are preserved.
Default worktrees and configured or database-referenced workspace locations stay
in place at their exact current paths, including ignored files, dependencies,
untracked files and uncommitted edits. The script does not recursively filter
repositories. A workspace overlapping userdata is refused because it cannot be
safely separated. Workspace intersections with desktop state, the Applications
directory or the backup directory also stop the updater before replacement.
Source profile symlinks are refused; managed workspace symlinks
are left in place. The JSON scope manifest records preserved profile entries and
workspace locations. Backups cannot recover workspaces deleted or damaged later.
Restoring an older database may omit newer conversations while their files survive.

Rollback first quarantines current application state. Version 2 restores replace
only scoped state; they never replace the whole profile or reset Git worktrees.
Missing workspace directories or checkpoint refs are reported, without recreation.
Restored settings disable automatic worktree cleanup and continuation after server
restart, including project overrides; the original settings remain in the snapshot
and quarantine. Rollback stays stopped so workspace/history reconciliation can
happen before reopening the app. Snapshots with enabled schedules or pending or
running effect-outbox work are refused before replacing current state: choose a
quiescent snapshot or obtain an offline recovery review. Disabling worktree cleanup
does not disable scheduled tasks. Workspace inventory and unsafe-work checks read
both `state.sqlite` and `statev2.sqlite`, including when the latter is empty.
Unrecognized database schemas stop the operation for an offline recovery review.
This updater cannot safely restore legacy full-profile snapshots automatically.
It retains the selected snapshot and leaves current application state untouched.
Manual recovery needs a separate scoped conversion that preserves current workspace
files; this updater does not implement that conversion. This deliberate limitation
avoids replacing current files with the snapshot’s older worktrees.

Space checks reserve full scoped copies plus 20% and 1 GiB of headroom, without
counting old backups toward available space. Rollback also reserves room for the
selected state alongside quarantine. Checks are conservative across volumes and
cannot reserve space against other applications. Keep all profile writers stopped:
the app and launchd checks cannot prevent a separately started server from writing.
SQLite's backup API includes committed WAL data and checks database integrity;
other application files still require an offline copy.

Only one updater may run at a time. After a forced termination, verify that no
updater remains before removing the empty `.updater-lock` directory in the backup
root. Failed copies remain incomplete and cannot be selected for rollback; they
are never automatically deleted. An interrupted scoped rollback leaves a journal;
the next run restores the original app, application state and desktop state as
one recovery operation, then stops for inspection. The journal remains until all
parts match, including when the original app was absent or had a different name.
Interrupted copies and app bundles remain quarantined. Legacy full-profile
snapshots are excluded from automatic retention; complete scoped snapshots are
validated before pruning. Retention runs only after success.
Installation completion and a healthy relaunch are separate outcomes.

Do not use `t3 update`, `t3 service install`, or an upstream npm command to update
this fork. An unchanged upstream client may still display its own npm commands;
the fork rejects unsupported RPC updates, but cannot prevent someone from running
an external command. Existing installations need a manual update to receive this
guidance.

## Supported upstream environments

The server update actions below apply only when the destination explicitly
identifies a supported upstream installation. They do not enable fork updates.

The app you use and the server running your agents can be on different machines.
When a server is behind your web or desktop app, the update button at the bottom
of the sidebar and **Settings → Environments** offer to update it.

## Update everything at once

The update button at the bottom of the sidebar updates every connected machine
in one step. It updates outdated providers, then servers that are behind, then
the desktop app you are using. Servers move to the
version your desktop app is installing, or to your web app's version. A
background service stays on its current release channel. A remote desktop app
installs the latest release from its own channel. Hover the button to see what
it will update.

While it runs, the button widens to show progress. It names a machine that is
taking longer than usual, and offers **Retry** for a server that failed. Click
it to see every machine. The desktop app restarts once each server has started
its own restart, after a short countdown. Choose **Later** to keep working and
restart from the update button when you are ready. A server still restarting
finishes on its own, and the button keeps showing it after the desktop app
restarts.

Remote desktop apps never wait for npm. When the desktop app offers the update,
background services update right away too. Other servers, including older
background services, update only after that version is published to npm. The
confirmation lists each machine it skips and why, such as a machine that is
offline or needs a manual update. Use **Settings → Environments** for those.

If a desktop app restarts on its old version, Tx Code tells you the update did
not apply. It does not install that version again on its own, even when another
device asks. Use the update button on that machine to retry.

The confirmation counts the running threads that the restarts will interrupt,
and how many can resume afterwards. See **Continue threads after restarts**
below.

## Switch between Stable and Nightly

In the desktop app, change **Settings → About → Update track**. Tx Code shows each
connected machine it will move and each one it skips, then moves them in one
step. Remote servers install the latest release on the new track. Remote desktop
apps reinstall on the new track. This app reinstalls last. Your threads,
settings, and data stay.

A background service cannot move to an older release remotely. When Stable is
older than its Nightly, run `t3 update --channel stable --allow-downgrade` on
that machine.

A switch is blocked for a machine whose database already has changes the
target release does not support, or when Tx Code cannot confirm that it does.
The dialog says why: update a machine on its current track first when its
release is too old to check, or wait until the target track includes the
changes. A Mac running the desktop app must switch on that Mac.

Each machine keeps the new track even if its switch did not finish, but it
moves to that track only through a switch. **Update track** shows how many
machines still run the other track. **Review** opens the same dialog with fresh
checks.

## Before you update

Server updates restart the connection and can interrupt active agents and
terminal commands. Saved threads, settings, and project files remain.

**Settings → Maintenance → Continue threads after restarts** is on by default.
It resumes supported active threads after an update, crash, or machine
restart. Changes are saved to connected environments that support this setting;
update older servers first. If a supported environment was offline or has a
different value, use **Apply to all** in Settings after it connects.
T3 Code must start again on that machine;
the setting does not enable automatic startup. Terminal commands may still be
interrupted, and threads without saved provider resume state need a new message.
A thread that finished its turn to wait on a subagent, a background task, or a
command or monitor the agent said it was waiting on is woken and told that this work
stopped. Other background shells and monitors, such as a dev server and its
watchdog, do not wake it; the thread learns about them with your next message.
A thread is not resumed while it waits for your approval, answer, or secret, or
while it is archived, snoozed, or settled. After three automatic resumes in a row,
the thread waits for your next message.

Updates from the previous orchestration system preserve conversation transcripts but cannot carry
every kind of runtime history forward. Read [Threads from older T3 Code versions](./thread-migration.md)
before continuing an important older thread.

## When versions don't match

A client and server must speak the same orchestration protocol. If they do not, the connection is
refused rather than running half-upgraded:

- An app newer than the server is blocked before connecting, with a notice telling you to update
  T3 Code on the machine named in the notice.
- A server newer than your app refuses the connection with an update message.

Update the side the notice names, then reconnect.

## Update a connected server

The offered action depends on how the server runs:

| Action                     | What to do                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Update server**          | Keep the client open while it installs and reconnects. Supported background services update remotely. For a desktop-hosted server, this also closes and relaunches the desktop app on the host. |
| **Update the desktop app** | Update the desktop app on the machine running the server, then reopen it if needed.                                                                                                             |
| **Copy update command**    | Run the command on the named host to update the detected global npm install, then restart the server with your usual options.                                                                   |
| **Copy relaunch command**  | Stop the command-line server on its host and relaunch with the copied command, keeping your usual subcommand and options. This does not update an installed `t3` command.                       |

On the host, run:

```sh
t3 update <client-version>
```

Replace `<client-version>` with the version shown in the notice. The command
asks before restarting the background service; if you decline, run
`t3 service restart` when you are ready. For a server you started by hand,
stop it and start it again afterwards with your usual options such as `--host`
or `--tailscale-serve`.

If you run the server with `npx` rather than an installed `t3`, there is
nothing to update on the host: stop the server and relaunch it as
`npx t3@<client-version>` with the same subcommand and options.

## If an update fails

Keep the client open until it reconnects or reports a failure. A failed service
update can roll back to the previous version. If the update still fails:

1. Retry the offered action once.
2. Check that you updated the server's machine, not only the device you are using.
3. For a command-line server, stop it and relaunch the exact version shown in the notice.

Only one server can use a T3 home directory at a time. If startup reports that
another server owns it, stop that server before retrying, or use a separate home
directory and pair with the running server.

## If the desktop app does not start

If the desktop app's server keeps failing at startup, Tx Code shows a "Tx Code
could not start" window instead of the app. If a newer version is available,
choose **Update** to install it. If not, the window links to the last version
that started on your computer. Download and install it to go back. Use **Copy
details** to include the error in a bug report.

## Update providers

**Settings → Providers** shows provider updates for the selected environment.
**Update all** updates every outdated provider on every connected environment
at once. Hover it to see which providers it will update. Providers that only
offer a manual update command are not included.

After a successful provider CLI update, Tx Code refreshes model discovery for
every enabled instance of that provider using its own configuration. Connected
clients receive the refreshed catalogs automatically. Provider update checks
must be enabled to download the latest Tx Code model catalog.

Provider updates do not restart running chats. An existing session can keep
using the previous CLI until it ends. If discovery fails, check the provider
status and refresh it again.

## Mobile updates

To update an environment from your phone, open **Settings → Environments** and
select it. **Check for updates** finds the latest release on that environment's
current release channel. Keep the app open while the environment updates and
reconnects. Hosts that cannot update remotely show instructions for updating on
the machine instead.

The same page lets you refresh provider status and update supported providers.
These controls require a connected environment and permission to operate it.
Provider update checks and restart continuation preferences are in
**Settings → Maintenance**. If provider update checks are disabled, enable them
there before refreshing to find newer versions. The same setting controls whether
Tx Code downloads model catalog updates, so with it off new models may not appear
until you enable it and refresh provider status.

Install App Store or Google Play releases as usual. The mobile app can also
download updates in the background and apply them when you next leave the app.
It saves drafts and queued messages before restarting. If you keep the app open
for a long time, it may ask to install immediately; choosing **Later** leaves the
update queued for the next suitable moment.
