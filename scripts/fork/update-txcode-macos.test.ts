// @effect-diagnostics nodeBuiltinImport:off - Exercises the shell updater with isolated macOS command fixtures.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { expect, it } from "vite-plus/test";

const latest = "0.1.6-nightly.20261030.3919";
const older = "0.1.5-nightly.20261029.3900";
const dmg = (version: string) => `Tx-Code-${version}-x64.dmg`;
const payload = "fixture dmg";
const hash = NodeCrypto.createHash("sha256").update(payload).digest("hex");
const updater = NodePath.join(import.meta.dirname, "update-txcode-macos.sh");
const isId = (name: string) => /^\d{8}T\d{6}Z$/.test(name);
const release = (tag: string, overrides = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: true,
  published_at: "2026-10-30T04:00:00Z",
  assets: [
    { name: dmg(tag.slice(1)), size: payload.length },
    { name: "SHA256SUMS", size: 200 },
  ],
  ...overrides,
});
const releases = [
  release("v9.0.0", { prerelease: false }),
  release("v0.1.6-nightly.20261031.1", { draft: true }),
  release("v0.1.6-prc-media.20261031.2"),
  release(`v${older}`),
  release(`v${latest}`),
  release("v0.1.6-nightly.20261030.999"),
];

// One /bin/sh stub stands in for every macOS tool the updater must not really run.
const stub = `#!/bin/sh
name=\${0##*/}
printf '%s %s\\n' "$name" "$*" >> "$TXCODE_UPDATE_FIXTURE_ROOT/calls"
case $name in
  uname) if [ "$1" = -s ]; then echo Darwin; else echo "\${FIXTURE_ARCH:-x86_64}"; fi ;;
  df) printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\nfixture 999999999 0 %s 0%% /\\n' "\${FIXTURE_AVAILABLE:-999999999}" ;;
  launchctl) echo 'PID Status Label' ;;
  file) echo 'Mach-O 64-bit executable x86_64' ;;
  open) exit "\${FIXTURE_OPEN_STATUS:-0}" ;;
  sleep) ;;
  date)
    case "$*" in
      *%Y%m%dT%H%M%SZ*)
        n=$(cat "$TXCODE_UPDATE_FIXTURE_ROOT/date-counter" 2>/dev/null || echo 0); n=$((n + 1))
        echo "$n" > "$TXCODE_UPDATE_FIXTURE_ROOT/date-counter"
        printf '20261030T06%02d%02dZ\n' $((n / 60)) $((n % 60)) ;;
      *) echo 2026-10-30T06:00:00Z ;;
    esac ;;
  osascript)
    for arg; do printf '%s\\n' "$arg"; done >> "$TXCODE_UPDATE_FIXTURE_ROOT/osascript-args"
    if [ "\${FIXTURE_QUITS:-}" = 1 ]; then : > "$TXCODE_UPDATE_PS"; fi
    exit "\${FIXTURE_OSASCRIPT_STATUS:-0}" ;;
  hdiutil)
    if [ "$1" = attach ]; then
      for arg; do image=$arg; done
      while [ $# -gt 0 ]; do if [ "$1" = -mountpoint ]; then mountpoint=$2; fi; shift; done
      cp -R "$TXCODE_UPDATE_FIXTURE_ROOT/dmgs/\${image##*/}/" "$mountpoint/"
    fi ;;
  ditto) if [ -n "\${FIXTURE_COPY_FAILURE:-}" ]; then exit 1; fi; cp -R "$1" "$2" ;;
  sqlite3)
    case "$*" in *quick_check*) if [ -n "\${FIXTURE_CORRUPT:-}" ]; then echo '*** in database main ***'; exit 0; fi ;; esac
    exec /usr/bin/sqlite3 "$@" ;;
  curl)
    for arg; do case $arg in http*) url=$arg ;; esac; done
    case "\${FIXTURE_TRANSFER_FAILURE:-}:$url" in lookup:*per_page*|dmg:*.dmg|checksum:*/SHA256SUMS) exit 28 ;; esac
    exec /usr/bin/curl "$@" ;;
esac
`;
const terminal = `import os, pty, select, sys
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
try:
    while True:
        readable, _, _ = select.select([fd, sys.stdin], [], [])
        if fd in readable:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            os.write(sys.stdout.fileno(), data)
        if sys.stdin in readable:
            data = os.read(sys.stdin.fileno(), 4096)
            if not data:
                break
            os.write(fd, data)
finally:
    _, status = os.waitpid(pid, 0)
    raise SystemExit(os.waitstatus_to_exitcode(status))
`;

async function writeApp(path: string, version: string, marker = version) {
  await NodeFSP.mkdir(NodePath.join(path, "Contents/MacOS"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(path, "Contents/Resources"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(path, "Contents/Info.plist"),
    JSON.stringify({
      CFBundleIdentifier: "net.coriou.txcode",
      CFBundleShortVersionString: version,
      CFBundleExecutable: "Tx Code",
    }),
  );
  await NodeFSP.writeFile(NodePath.join(path, "Contents/MacOS/Tx Code"), "fixture");
  await NodeFSP.writeFile(
    NodePath.join(path, "Contents/Resources/app.asar"),
    '{"t3codeCommitHash":"abcdef1234567890"}',
  );
  await NodeFSP.writeFile(NodePath.join(path, "Contents/marker"), marker);
}

function writeDatabase(path: string, rows: number) {
  const db = new NodeSqlite.DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
  db.exec("CREATE TABLE IF NOT EXISTS t (v TEXT)");
  const insert = db.prepare("INSERT INTO t VALUES (?)");
  db.exec("BEGIN");
  for (let i = 0; i < rows; i++) insert.run("x".repeat(512));
  db.exec("COMMIT");
  return db;
}
function countRows(path: string) {
  const db = new NodeSqlite.DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

interface RunResult {
  code: number | null;
  output: string;
}

async function fixture(
  options: {
    installed?: "Tx Code.app" | "Tx Code (Nightly).app";
    installedVersion?: string;
    state?: boolean;
    running?: boolean;
    checksum?: string;
  } = {},
) {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "txcode-updater-test-")),
  );
  const at = (...parts: string[]) => NodePath.join(root, ...parts);
  const apps = at("Applications");
  const backups = at("backups");
  const userdata = at("home/.txcode/userdata");
  const desktop = at("home/Library/Application Support/txcode-v2");
  const downloads = at("download-tmp");
  const requests: string[] = [];
  const openDatabases: NodeSqlite.DatabaseSync[] = [];
  const server = NodeHttp.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    requests.push(url.pathname);
    const tagged = url.pathname.match(/^\/repos\/Coriou\/txcode\/releases\/tags\/(.+)$/);
    const file = url.pathname.split("/").at(-1) ?? "";
    if (url.pathname === "/repos/Coriou/txcode/releases") response.end(JSON.stringify(releases));
    else if (tagged) {
      const found = releases.find((entry) => entry.tag_name === tagged[1]);
      response.statusCode = found ? 200 : 404;
      response.end(JSON.stringify(found ?? {}));
    } else if (file.endsWith(".dmg")) response.end(payload);
    else if (file === "SHA256SUMS") {
      const name = dmg(url.pathname.split("/").at(-2)!.slice(1));
      response.end(`${options.checksum ?? hash}  ${name}\n`);
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  await Promise.all(
    [apps, backups, downloads, at("bin"), userdata, desktop].map((path) =>
      NodeFSP.mkdir(path, { recursive: true }),
    ),
  );
  for (const name of [
    "uname",
    "df",
    "launchctl",
    "file",
    "open",
    "sleep",
    "date",
    "osascript",
    "hdiutil",
    "ditto",
    "sqlite3",
    "curl",
  ]) {
    await NodeFSP.writeFile(at("bin", name), stub, { mode: 0o755 });
  }
  await NodeFSP.writeFile(at("terminal.py"), terminal);
  for (const version of [latest, older])
    await writeApp(at("dmgs", dmg(version), "Tx Code.app"), version);
  if (options.installed) {
    await writeApp(
      NodePath.join(apps, options.installed),
      options.installedVersion ?? older,
      "current app",
    );
  }
  await NodeFSP.writeFile(
    at("processes"),
    options.running
      ? `${apps}/Tx Code.app/Contents/Frameworks/Tx Code Helper.app/Contents/MacOS/Tx Code Helper\n`
      : `/worktree/Tx Code.app/script\n/Applications/T3 Code.app/Contents/MacOS/T3 Code\n`,
  );
  if (options.state) {
    openDatabases.push(writeDatabase(NodePath.join(userdata, "statev2.sqlite"), 4000));
    await NodeFSP.writeFile(NodePath.join(userdata, "settings.json"), '{"generation":"current"}');
    await NodeFSP.mkdir(NodePath.join(userdata, "secrets"), { mode: 0o700 });
    await NodeFSP.writeFile(NodePath.join(userdata, "secrets/server-signing-key.bin"), "secret");
    await NodeFSP.mkdir(NodePath.join(userdata, "attachments/thread"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(userdata, "attachments/thread/image.png"), "image");
    for (const excluded of ["logs", "browser-artifacts", "server-browser"]) {
      await NodeFSP.mkdir(NodePath.join(userdata, excluded));
      await NodeFSP.writeFile(NodePath.join(userdata, excluded, "big"), "not backed up");
    }
    await NodeFSP.mkdir(at("home/.txcode/worktrees/repo/branch/node_modules"), { recursive: true });
    await NodeFSP.writeFile(
      at("home/.txcode/worktrees/repo/branch/node_modules/keep"),
      "current dependency",
    );
    for (const entry of ["Local Storage", "IndexedDB", "Cache"]) {
      await NodeFSP.mkdir(NodePath.join(desktop, entry));
      await NodeFSP.writeFile(NodePath.join(desktop, entry, "data"), "current desktop");
    }
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture listener");
  const origin = `http://127.0.0.1:${address.port}`;
  const source = await NodeFSP.readFile(updater, "utf8");
  // Quotes and spaces in the script path exercise the Terminal handoff quoting.
  const script = at(`odd "dir" it's`, "update.sh");
  await NodeFSP.mkdir(NodePath.dirname(script));
  await NodeFSP.writeFile(script, source.replace(/https:\/\/(api\.)?github\.com/g, origin));

  const run = (
    args: string[],
    { env = {}, answers }: { env?: Record<string, string>; answers?: string[] } = {},
  ) =>
    new Promise<RunResult>((resolve, reject) => {
      const command = answers
        ? ["python3", [at("terminal.py"), "/bin/bash", script, ...args]]
        : ["/bin/bash", [script, ...args]];
      const child = NodeChildProcess.spawn(command[0] as string, command[1] as string[], {
        env: {
          ...process.env,
          NO_COLOR: "1",
          PATH: `${at("bin")}:${process.env.PATH}`,
          TMPDIR: downloads,
          TXCODE_UPDATE_FIXTURE: "1",
          TXCODE_UPDATE_FIXTURE_ROOT: root,
          TXCODE_UPDATE_APPS: apps,
          TXCODE_UPDATE_BACKUPS: backups,
          TXCODE_UPDATE_PS: at("processes"),
          ...env,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      let answered = 0;
      const receive = (chunk: Buffer) => {
        output += chunk.toString();
        const prompts = output.match(/\[(Y\/n|y\/N|1-\d+, Enter to cancel)\] /g)?.length ?? 0;
        while (answers && answered < prompts) child.stdin.write(`${answers[answered++] ?? ""}\n`);
      };
      child.stdout.on("data", receive);
      child.stderr.on("data", receive);
      child.on("error", reject);
      child.on("close", async (code) => {
        const leftovers = await NodeFSP.readdir(downloads);
        if (leftovers.length > 0)
          reject(new Error(`temporary files left: ${leftovers.join(", ")}`));
        else resolve({ code, output });
      });
    });

  return {
    root,
    script,
    apps,
    backups,
    userdata,
    desktop,
    requests,
    run,
    calls: () => NodeFSP.readFile(at("calls"), "utf8").catch(() => ""),
    ls: (path: string) => NodeFSP.readdir(path).then((names) => names.sort()),
    read: (path: string) => NodeFSP.readFile(path, "utf8").catch(() => ""),
    exists: (path: string) =>
      NodeFSP.lstat(path)
        .then(() => true)
        .catch(() => false),
    backupIds: () => NodeFSP.readdir(backups).then((names) => names.filter(isId).sort().reverse()),
    closeDatabases: () => {
      for (const db of openDatabases.splice(0)) db.close();
    },
    async makeBackup(
      id: string,
      backup: {
        version?: string;
        appName?: string;
        withApp?: boolean;
        complete?: boolean;
        settings?: string;
        pending?: boolean;
      } = {},
    ) {
      const dir = NodePath.join(backups, id);
      const appName = backup.appName ?? "Tx Code.app";
      const version = backup.version ?? older;
      await NodeFSP.mkdir(NodePath.join(dir, "userdata"), { recursive: true });
      await NodeFSP.mkdir(NodePath.join(dir, "desktop/Local Storage"), { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(dir, "manifest"),
        `format\ttxcode-backup-v3\nkind\tupdate\ncreated\t2026-10-01T00:00:00Z\napp-name\t${appName}\napp-version\t${version}\ntarget\t${latest}\nclone\tyes\n`,
      );
      await NodeFSP.writeFile(
        NodePath.join(dir, "userdata/settings.json"),
        backup.settings ?? "{}",
      );
      await NodeFSP.writeFile(NodePath.join(dir, "desktop/Local Storage/data"), "old desktop");
      const db = writeDatabase(NodePath.join(dir, "userdata/statev2.sqlite"), 3);
      if (backup.pending) {
        db.exec(`CREATE TABLE scheduled_tasks (title TEXT, enabled INTEGER);
          INSERT INTO scheduled_tasks VALUES ('Nightly build', 1), ('Paused', 0);
          CREATE TABLE orchestration_v2_effect_outbox (effect_type TEXT, status TEXT);
          INSERT INTO orchestration_v2_effect_outbox VALUES ('provider.turn.start', 'pending'), ('x', 'running'), ('y', 'succeeded');`);
      }
      db.close();
      if (backup.withApp ?? true)
        await writeApp(NodePath.join(dir, "app", appName), version, "backup app");
      if (backup.complete ?? true) await NodeFSP.writeFile(NodePath.join(dir, "complete"), "");
      return dir;
    },
    async makeLegacyBackup(id: string, complete = true) {
      const dir = NodePath.join(backups, id);
      await NodeFSP.mkdir(NodePath.join(dir, "profile/worktrees/repo"), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(dir, "BACKUP-MANIFEST.txt"), "tag\tvold\n");
      await NodeFSP.writeFile(NodePath.join(dir, "profile/worktrees/repo/file"), "x".repeat(4096));
      if (complete) await NodeFSP.writeFile(NodePath.join(dir, "complete"), "");
    },
    async [Symbol.asyncDispose]() {
      for (const db of openDatabases.splice(0)) db.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(root, { recursive: true, force: true });
    },
  };
}

it("clones allowlisted state, verifies it, swaps the app and reopens it", async () => {
  await using fx = await fixture({ installed: "Tx Code.app", state: true });
  const result = await fx.run(["--yes"]);
  fx.closeDatabases();
  expect(result.code, result.output).toBe(0);
  expect(result.output).toContain(`Updated ${older} -> ${latest}`);
  expect(fx.requests).toEqual([
    "/repos/Coriou/txcode/releases",
    `/Coriou/txcode/releases/download/v${latest}/${dmg(latest)}`,
    `/Coriou/txcode/releases/download/v${latest}/SHA256SUMS`,
  ]);
  expect(await fx.ls(fx.apps)).toEqual(["Tx Code.app"]);
  expect(await fx.read(NodePath.join(fx.apps, "Tx Code.app/Contents/marker"))).toBe(latest);
  const [id] = await fx.backupIds();
  const backup = NodePath.join(fx.backups, id!);
  expect(await fx.ls(backup)).toEqual(["app", "complete", "desktop", "manifest", "userdata"]);
  expect(await fx.read(NodePath.join(backup, "app/Tx Code.app/Contents/marker"))).toBe(
    "current app",
  );
  expect(await fx.ls(NodePath.join(backup, "userdata"))).toEqual([
    "attachments",
    "secrets",
    "settings.json",
    "statev2.sqlite",
  ]);
  expect(await fx.ls(NodePath.join(backup, "desktop"))).toEqual(["IndexedDB", "Local Storage"]);
  // Rows still in the live WAL at backup time are part of the verified snapshot.
  expect(countRows(NodePath.join(backup, "userdata/statev2.sqlite"))).toBe(4000);
  expect(await fx.read(NodePath.join(backup, "manifest"))).toContain("clone\tyes");
  expect(await fx.calls()).toMatch(/^open .*Tx Code\.app$/m);
  expect(await fx.calls()).not.toContain("osascript");
  expect(await fx.calls()).not.toContain("VACUUM");
  expect(
    await fx.read(NodePath.join(fx.root, "home/.txcode/worktrees/repo/branch/node_modules/keep")),
  ).toBe("current dependency");
});

it("falls back to full copies and VACUUM INTO when cloning is unavailable", async () => {
  await using fx = await fixture({ installed: "Tx Code.app", state: true });
  const result = await fx.run(["--yes"], { env: { TXCODE_UPDATE_CLONE: "0" } });
  fx.closeDatabases();
  expect(result.code, result.output).toBe(0);
  const [id] = await fx.backupIds();
  expect(await fx.read(NodePath.join(fx.backups, id!, "manifest"))).toContain("clone\tno");
  expect(await fx.calls()).toMatch(/^sqlite3 -readonly .*statev2\.sqlite VACUUM INTO /m);
  expect(countRows(NodePath.join(fx.backups, id!, "userdata/statev2.sqlite"))).toBe(4000);
});

it("summarises the update and asks once, defaulting to yes", async () => {
  await using fx = await fixture({ installed: "Tx Code.app", state: true });
  const result = await fx.run([], { answers: [""] });
  fx.closeDatabases();
  expect(result.code, result.output).toBe(0);
  expect(result.output).toContain(`Installed  ${older}`);
  expect(result.output).toContain(`Available  ${latest} (released 2026-10-30)`);
  expect(result.output).toMatch(/Backup +\d+ MB of app data, APFS clone/);
  expect(result.output.match(/\[Y\/n\]/g)).toHaveLength(1);
});

it("cancels before downloading when the summary is declined", async () => {
  await using fx = await fixture({ installed: "Tx Code.app" });
  const result = await fx.run([], { answers: ["n"] });
  expect(result.code, result.output).toBe(3);
  expect(fx.requests).toEqual(["/repos/Coriou/txcode/releases"]);
  expect(await fx.backupIds()).toEqual([]);
});

it("requires a terminal for questions unless --yes is given", async () => {
  await using fx = await fixture({ installed: "Tx Code.app" });
  const result = await fx.run([]);
  expect(result.code).toBe(2);
  expect(result.output).toContain("pass --yes");
  expect(fx.requests).toEqual([]);
});

it("exits 0 without downloading when already up to date, and --force reinstalls", async () => {
  await using fx = await fixture({ installed: "Tx Code.app", installedVersion: latest });
  const current = await fx.run(["--yes"]);
  expect(current.code, current.output).toBe(0);
  expect(current.output).toContain(`Already up to date (${latest})`);
  expect(fx.requests).toHaveLength(1);
  expect(await fx.backupIds()).toEqual([]);
  const forced = await fx.run(["--yes", "--force"]);
  expect(forced.code, forced.output).toBe(0);
  expect(await fx.backupIds()).toHaveLength(1);
});

it("dry run prints the plan and changes nothing", async () => {
  await using fx = await fixture({ installed: "Tx Code.app", state: true });
  await fx.makeBackup("20261001T000000Z", { complete: false });
  const result = await fx.run(["--dry-run"]);
  expect(result.code, result.output).toBe(0);
  expect(result.output).toContain("Dry run:");
  expect(fx.requests).toEqual(["/repos/Coriou/txcode/releases"]);
  expect(await fx.backupIds()).toEqual(["20261001T000000Z"]);
  expect(await fx.read(NodePath.join(fx.apps, "Tx Code.app/Contents/marker"))).toBe("current app");
});

it("installs a specific tag with --version", async () => {
  await using fx = await fixture();
  const result = await fx.run(["--yes", "--version", `v${older}`]);
  expect(result.code, result.output).toBe(0);
  expect(fx.requests[0]).toBe(`/repos/Coriou/txcode/releases/tags/v${older}`);
  expect(await fx.read(NodePath.join(fx.apps, "Tx Code.app/Contents/marker"))).toBe(older);
});

it("never downloads an Intel DMG on Apple Silicon", async () => {
  await using fx = await fixture();
  const result = await fx.run(["--yes"], { env: { FIXTURE_ARCH: "arm64" } });
  expect(result.code).toBe(5);
  expect(result.output).toContain("Apple Silicon builds are not published yet");
  expect(fx.requests).toHaveLength(1);
});

it("rejects a checksum mismatch before mounting, backing up or copying", async () => {
  await using fx = await fixture({ installed: "Tx Code.app", checksum: "0".repeat(64) });
  const result = await fx.run(["--yes"]);
  expect(result.code).toBe(5);
  expect(result.output).toContain("Checksum mismatch");
  expect(await fx.calls()).not.toMatch(/hdiutil|ditto/);
  expect(await fx.backupIds()).toEqual([]);
});

it.each([
  ["lookup", "Could not look up releases"],
  ["dmg", "The download failed"],
  ["checksum", "Downloading SHA256SUMS failed"],
] as const)(
  "stops on a bounded %s transfer failure before changing anything",
  async (failure, message) => {
    await using fx = await fixture({ installed: "Tx Code.app" });
    const result = await fx.run(["--yes"], { env: { FIXTURE_TRANSFER_FAILURE: failure } });
    expect(result.code, result.output).toBe(5);
    expect(result.output).toContain(message);
    expect(await fx.calls()).toContain(
      "--connect-timeout 15 --speed-limit 1024 --speed-time 60 --max-time 1800",
    );
    expect(await fx.calls()).not.toMatch(/hdiutil|ditto|open /);
    expect(await fx.backupIds()).toEqual([]);
  },
);

it("quits a running app gracefully before backing up", async () => {
  await using fx = await fixture({ installed: "Tx Code.app", running: true });
  const result = await fx.run(["--yes"], { env: { FIXTURE_QUITS: "1" } });
  expect(result.code, result.output).toBe(0);
  expect(await fx.calls()).toContain('osascript -e quit app id "net.coriou.txcode"');
  expect(await fx.backupIds()).toHaveLength(1);
});

it("stops when the app does not quit in time, without force-quitting or changing anything", async () => {
  await using fx = await fixture({ installed: "Tx Code.app", running: true });
  const result = await fx.run(["--yes"], { env: { TXCODE_UPDATE_QUIT_TIMEOUT: "3" } });
  expect(result.code, result.output).toBe(4);
  expect(result.output).toContain("did not quit within 3s");
  const calls = await fx.calls();
  expect(calls.match(/^sleep 1$/gm)).toHaveLength(3);
  expect(calls).not.toMatch(/^kill|pkill/m);
  expect(await fx.backupIds()).toEqual([]);
  expect(await fx.read(NodePath.join(fx.apps, "Tx Code.app/Contents/marker"))).toBe("current app");
});

it("refuses insufficient space before downloading", async () => {
  await using fx = await fixture({ installed: "Tx Code.app" });
  const result = await fx.run(["--yes"], { env: { FIXTURE_AVAILABLE: "1" } });
  expect(result.code, result.output).toBe(7);
  expect(result.output).toContain("Not enough free space");
  expect(fx.requests).toHaveLength(1);
  expect(await fx.backupIds()).toEqual([]);
});

it("keeps the old app when backup verification fails, then cleans up that backup on the next run", async () => {
  await using fx = await fixture({ installed: "Tx Code.app", state: true });
  const failed = await fx.run(["--yes"], { env: { FIXTURE_CORRUPT: "1" } });
  expect(failed.code, failed.output).toBe(6);
  expect(failed.output).toContain("failed SQLite's integrity check");
  expect(await fx.read(NodePath.join(fx.apps, "Tx Code.app/Contents/marker"))).toBe("current app");
  const [incomplete] = await fx.backupIds();
  expect(await fx.exists(NodePath.join(fx.backups, incomplete!, "complete"))).toBe(false);
  expect(await fx.calls()).not.toContain("ditto");

  const retried = await fx.run(["--yes"]);
  fx.closeDatabases();
  expect(retried.code, retried.output).toBe(0);
  expect(retried.output).toContain(`Removed incomplete backup ${incomplete}`);
  expect(await fx.backupIds()).not.toContain(incomplete);
});

it("keeps the previous app in place when staging the new app fails", async () => {
  await using fx = await fixture({ installed: "Tx Code.app" });
  const result = await fx.run(["--yes"], { env: { FIXTURE_COPY_FAILURE: "1" } });
  expect(result.code).not.toBe(0);
  expect(await fx.ls(fx.apps)).toEqual(["Tx Code.app"]);
  expect(await fx.read(NodePath.join(fx.apps, "Tx Code.app/Contents/marker"))).toBe("current app");
});

it("reports a completed installation separately when reopening fails", async () => {
  await using fx = await fixture({ installed: "Tx Code.app" });
  const result = await fx.run(["--yes"], { env: { FIXTURE_OPEN_STATUS: "99" } });
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain(`Installed ${latest}, but macOS could not open it`);
  const [id] = await fx.backupIds();
  expect(await fx.ls(NodePath.join(fx.backups, id!))).toContain("complete");
});

it("keeps the newest three complete backups and never touches legacy or symlinked entries", async () => {
  await using fx = await fixture({ installed: "Tx Code.app" });
  for (const id of [
    "20261001T000000Z",
    "20261002T000000Z",
    "20261003T000000Z",
    "20261004T000000Z",
  ]) {
    await fx.makeBackup(id);
  }
  await fx.makeLegacyBackup("20260901T000000Z");
  const outside = NodePath.join(fx.root, "outside");
  await NodeFSP.mkdir(outside);
  await NodeFSP.writeFile(NodePath.join(outside, "complete"), "");
  await NodeFSP.symlink(outside, NodePath.join(fx.backups, "20261005T000000Z"));
  const result = await fx.run(["--yes"]);
  expect(result.code, result.output).toBe(0);
  const ids = await fx.backupIds();
  expect(ids.slice(1)).toEqual([
    "20261005T000000Z",
    "20261004T000000Z",
    "20261003T000000Z",
    "20260901T000000Z",
  ]);
  expect(ids).toHaveLength(5);
  expect(await fx.ls(outside)).toEqual(["complete"]);
  expect(result.output).toContain("1 backup(s) from an older updater");
});

it("rolls back app and data, backs up the current state first, keeps its source, and can be undone", async () => {
  await using fx = await fixture({
    installed: "Tx Code.app",
    installedVersion: latest,
    state: true,
  });
  fx.closeDatabases();
  const source = "20261001T000000Z";
  const oldSettings = {
    generation: "old",
    worktreeOnDelete: true,
    worktreeAfterDays: 7,
    worktreeCleanup: { mode: "custom", rules: { worktreeOnDelete: true } },
    projectSettingsOverrides: { "project.with.dots": { worktreeCleanup: { mode: "custom" } } },
  };
  await fx.makeBackup(source, { settings: JSON.stringify(oldSettings) });
  for (const id of ["20261002T000000Z", "20261003T000000Z", "20261004T000000Z"]) {
    await fx.makeBackup(id, { version: latest });
  }
  await NodeFSP.writeFile(NodePath.join(fx.userdata, "statev2.sqlite-wal"), "stale wal");

  const result = await fx.run(["rollback", source, "--yes"]);
  expect(result.code, result.output).toBe(0);
  expect(result.output).toContain(`Rolled back to ${older}`);
  expect(result.output).toContain("Automatic worktree cleanup is off until you re-enable it");
  expect(result.output).not.toContain("Pending");
  expect(await fx.read(NodePath.join(fx.apps, "Tx Code.app/Contents/marker"))).toBe("backup app");
  expect(JSON.parse(await fx.read(NodePath.join(fx.userdata, "settings.json")))).toEqual({
    generation: "old",
    continueThreadsAfterServerUpdate: false,
    worktreeCleanup: { mode: "off" },
    worktreeAfterDays: null,
    worktreeSettledAfterDays: null,
    worktreeOnMerge: false,
    worktreeOnDelete: false,
    worktreeUnchanged: false,
    projectSettingsOverrides: {
      "project.with.dots": {
        continueThreadsAfterServerUpdate: false,
        worktreeCleanup: { mode: "off" },
      },
    },
  });
  expect(await fx.read(NodePath.join(fx.backups, source, "userdata/settings.json"))).toBe(
    JSON.stringify(oldSettings),
  );
  expect(await fx.exists(NodePath.join(fx.userdata, "statev2.sqlite-wal"))).toBe(false);
  expect(countRows(NodePath.join(fx.userdata, "statev2.sqlite"))).toBe(3);
  expect(await fx.read(NodePath.join(fx.desktop, "Local Storage/data"))).toBe("old desktop");
  expect(await fx.read(NodePath.join(fx.desktop, "Cache/data"))).toBe("current desktop");
  expect(
    await fx.read(NodePath.join(fx.root, "home/.txcode/worktrees/repo/branch/node_modules/keep")),
  ).toBe("current dependency");
  expect(await fx.calls()).not.toMatch(/^open /m);
  const ids = await fx.backupIds();
  expect(ids).toContain(source);
  expect(await fx.exists(NodePath.join(fx.backups, source, "app/Tx Code.app"))).toBe(true);
  const quarantine = ids[0]!;
  expect(
    await fx.read(NodePath.join(fx.backups, quarantine, "app/Tx Code.app/Contents/marker")),
  ).toBe("current app");
  expect(await fx.exists(NodePath.join(fx.backups, ".rollback-in-progress"))).toBe(false);

  const undo = await fx.run(["rollback", quarantine, "--yes"]);
  expect(undo.code, undo.output).toBe(0);
  expect(await fx.read(NodePath.join(fx.apps, "Tx Code.app/Contents/marker"))).toBe("current app");
  expect(JSON.parse(await fx.read(NodePath.join(fx.userdata, "settings.json")))).toMatchObject({
    generation: "current",
    worktreeCleanup: { mode: "off" },
  });
  expect(countRows(NodePath.join(fx.userdata, "statev2.sqlite"))).toBe(4000);
});

it("warns about enabled schedules and pending work and needs a confirmation --yes cannot give", async () => {
  await using fx = await fixture({
    installed: "Tx Code.app",
    installedVersion: latest,
    state: true,
  });
  fx.closeDatabases();
  const source = "20261001T000000Z";
  await fx.makeBackup(source, { pending: true, settings: '{"generation":"old"}' });
  const unchanged = async () => {
    expect(JSON.parse(await fx.read(NodePath.join(fx.userdata, "settings.json"))).generation).toBe(
      "current",
    );
    expect(await fx.backupIds()).toEqual([source]);
  };

  const refused = await fx.run(["rollback", source, "--yes"]);
  expect(refused.code, refused.output).toBe(6);
  expect(refused.output).toContain("--accept-pending");
  expect(refused.output).toContain("1 enabled schedule(s)\n      Nightly build\n");
  expect(refused.output).toContain("2 pending or running effect(s)");
  await unchanged();

  const declined = await fx.run(["rollback", source, "--yes"], { answers: ["n"] });
  expect(declined.code, declined.output).toBe(3);
  expect(declined.output).toContain("Roll back anyway?");
  await unchanged();

  const accepted = await fx.run(["rollback", source, "--yes", "--accept-pending"]);
  expect(accepted.code, accepted.output).toBe(0);
  expect(accepted.output).toContain("Before opening Tx Code, review the restored schedules");
  expect(JSON.parse(await fx.read(NodePath.join(fx.userdata, "settings.json"))).generation).toBe(
    "old",
  );
});

it("hands off to Terminal instead of mutating when run inside Tx Code", async () => {
  await using fx = await fixture({ installed: "Tx Code.app" });
  const ancestry = NodePath.join(fx.root, "ancestry");
  await NodeFSP.writeFile(
    ancestry,
    `100 50 -zsh\n50 40 ${fx.apps}/Tx Code.app/Contents/Frameworks/Tx Code Helper.app/Contents/MacOS/Tx Code Helper --type=pty\n40 1 ${fx.apps}/Tx Code.app/Contents/MacOS/Tx Code\n`,
  );
  const env = { TXCODE_UPDATE_ANCESTRY: ancestry, TXCODE_UPDATE_START_PID: "100" };

  const preview = await fx.run(["--dry-run"], { env });
  expect(preview.code, preview.output).toBe(0);
  const status = await fx.run(["status"], { env });
  expect(status.code, status.output).toBe(0);

  const handed = await fx.run(["--yes", "--version", `v${latest}`], { env });
  expect(handed.code, handed.output).toBe(0);
  expect(handed.output).toContain("Opened Terminal");
  const script = (await fx.read(NodePath.join(fx.root, "osascript-args")))
    .split("\n")
    .find((line) => line.startsWith('tell application "Terminal" to do script '))!;
  const command = JSON.parse(script.slice('tell application "Terminal" to do script '.length));
  const words = NodeChildProcess.execFileSync(
    "/bin/bash",
    ["-c", 'eval "words=($1)"; printf "%s\\n" "${words[@]}"', "_", command],
    { encoding: "utf8" },
  );
  expect(words).toBe(["/bin/bash", fx.script, "--yes", "--version", `v${latest}`, ""].join("\n"));

  const failed = await fx.run(["--yes"], { env: { ...env, FIXTURE_OSASCRIPT_STATUS: "1" } });
  expect(failed.code, failed.output).toBe(4);
  expect(failed.output).toContain("Run this from Terminal instead: /bin/bash ");
  expect(fx.requests).toEqual(["/repos/Coriou/txcode/releases", "/repos/Coriou/txcode/releases"]);
  expect(await fx.backupIds()).toEqual([]);
  expect(await fx.exists(NodePath.join(fx.backups, ".updater-lock"))).toBe(false);
});

it("refuses to roll back data-only backups onto a different app version", async () => {
  await using fx = await fixture({
    installed: "Tx Code.app",
    installedVersion: latest,
    state: true,
  });
  fx.closeDatabases();
  await fx.makeBackup("20261001T000000Z", { withApp: false });
  const result = await fx.run(["rollback", "20261001T000000Z", "--yes"]);
  expect(result.code, result.output).toBe(6);
  expect(result.output).toContain("no app copy");
  expect(await fx.read(NodePath.join(fx.userdata, "settings.json"))).toBe(
    '{"generation":"current"}',
  );
  expect(await fx.backupIds()).toEqual(["20261001T000000Z"]);
});

it("puts back a previous app left aside when no app is installed, then updates", async () => {
  await using fx = await fixture();
  await writeApp(NodePath.join(fx.apps, "Tx Code.app.aside"), older, "current app");
  const result = await fx.run(["--yes"]);
  expect(result.code, result.output).toBe(0);
  expect(result.output).toContain("Put back Tx Code.app");
  expect(await fx.ls(fx.apps)).toEqual(["Tx Code.app"]);
  const [id] = await fx.backupIds();
  expect(await fx.read(NodePath.join(fx.backups, id!, "app/Tx Code.app/Contents/marker"))).toBe(
    "current app",
  );
});

it("files a renamed Nightly app left aside into its backup after the new Tx Code.app landed", async () => {
  await using fx = await fixture({ installed: "Tx Code.app", installedVersion: latest });
  await writeApp(NodePath.join(fx.apps, "Tx Code (Nightly).app.aside"), older, "nightly app");
  await fx.makeBackup("20261001T000000Z", { appName: "Tx Code (Nightly).app", withApp: false });
  const result = await fx.run(["--yes"]);
  expect(result.code, result.output).toBe(0);
  expect(result.output).toContain("moved the previous app into backup 20261001T000000Z");
  expect(result.output).toContain(`Already up to date (${latest})`);
  expect(await fx.ls(fx.apps)).toEqual(["Tx Code.app"]);
  expect(
    await fx.read(
      NodePath.join(fx.backups, "20261001T000000Z/app/Tx Code (Nightly).app/Contents/marker"),
    ),
  ).toBe("nightly app");
});

it.each([
  ["an unmatched aside", "Tx Code.app.aside", "left"],
  ["both app names", "Tx Code (Nightly).app", "Both"],
] as const)(
  "changes nothing when %s is next to the installed app",
  async (_name, extra, message) => {
    await using fx = await fixture({ installed: "Tx Code.app", installedVersion: latest });
    await writeApp(NodePath.join(fx.apps, extra), older);
    const result = await fx.run(["--yes"]);
    expect(result.code, result.output).toBe(6);
    expect(result.output).toContain(message);
    expect(await fx.ls(fx.apps)).toEqual([extra, "Tx Code.app"].sort());
    expect(fx.requests).toEqual([]);
  },
);

it("refuses a lock held by another run without removing it", async () => {
  await using fx = await fixture({ installed: "Tx Code.app" });
  await NodeFSP.mkdir(NodePath.join(fx.backups, ".updater-lock"));
  const result = await fx.run(["--yes"]);
  expect(result.code, result.output).toBe(6);
  expect(result.output).toContain("Another updater run holds");
  expect(await fx.exists(NodePath.join(fx.backups, ".updater-lock"))).toBe(true);
  expect(fx.requests).toEqual([]);
});

it("status lists versions and backups without changing anything", async () => {
  await using fx = await fixture({ installed: "Tx Code.app" });
  await fx.makeBackup("20261001T000000Z");
  await fx.makeBackup("20261002T000000Z", { complete: false });
  await fx.makeLegacyBackup("20260901T000000Z");
  const result = await fx.run(["status"]);
  expect(result.code, result.output).toBe(0);
  expect(result.output).toContain(`${latest} (released 2026-10-30), update available`);
  expect(result.output).toMatch(/20261001T000000Z +update +app 0\.1\.5/);
  expect(result.output).not.toContain("20261002T000000Z");
  expect(result.output).toContain("1 backup(s) from an older updater");
  expect(await fx.backupIds()).toEqual([
    "20261002T000000Z",
    "20261001T000000Z",
    "20260901T000000Z",
  ]);
});

it("prune-legacy deletes only legacy backups, after showing their sizes", async () => {
  await using fx = await fixture();
  await fx.makeLegacyBackup("20260901T000000Z");
  await fx.makeLegacyBackup("20260902T000000Z", false);
  await fx.makeBackup("20261001T000000Z");
  const declined = await fx.run(["prune-legacy"], { answers: [""] });
  expect(declined.code, declined.output).toBe(3);
  expect(declined.output).toMatch(/20260902T000000Z +\d+ KB, incomplete/);
  expect(await fx.backupIds()).toHaveLength(3);
  const result = await fx.run(["prune-legacy", "--yes"]);
  expect(result.code, result.output).toBe(0);
  expect(await fx.backupIds()).toEqual(["20261001T000000Z"]);
});
