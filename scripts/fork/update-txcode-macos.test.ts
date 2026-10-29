// @effect-diagnostics nodeBuiltinImport:off - Exercises the shell updater with isolated macOS command fixtures.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

const version = "0.1.3-nightly.20261027.42";
const archive = `Tx-Code-${version}-x64.dmg`;
const payload = "fixture dmg";
const hash = NodeCrypto.createHash("sha256").update(payload).digest("hex");
const release = (tag: string, overrides = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: true,
  assets: [
    { name: archive, size: payload.length },
    { name: "SHA256SUMS", size: 200 },
  ],
  ...overrides,
});

async function fixture(
  options: {
    crash?: "installed" | "displaced";
    state?: boolean;
    scopedRollback?: boolean;
    unsafeSnapshot?: boolean;
    locked?: boolean;
    copyFailure?: boolean;
    lowSpace?: boolean;
    arm?: boolean;
    running?: boolean;
    checksum?: string;
    star?: boolean;
    backups?: boolean;
    scopedBackups?: boolean;
    escape?: boolean;
    forbidden?: string;
    pipe?: boolean;
    aside?: "only" | "both";
    installed?: boolean | "nightly";
    rollbackId?: string;
    confirms?: number;
    transferFailure?: "lookup" | "dmg" | "checksum";
  } = {},
) {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "txcode-updater-test-")),
  );
  const apps = NodePath.join(root, "Applications");
  const backups = NodePath.join(root, "backups");
  const bin = NodePath.join(root, "bin");
  const downloadTmp = NodePath.join(root, "download-tmp");
  const requests: string[] = [];
  const server = NodeHttp.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    requests.push(url.pathname);
    if (url.pathname === "/repos/Coriou/txcode/releases") {
      response.end(
        JSON.stringify([
          release("v9.0.0", { prerelease: false }),
          release("v0.1.3-nightly.20261028.100", { draft: true }),
          release("v0.1.3-prc-media.20261029.200"),
          release("v0.1.3-nightly.20261027.9"),
          release(`v${version}`),
          release("v0.1.3-nightly.20261026.999"),
        ]),
      );
    } else if (url.pathname.endsWith(`/${archive}`)) response.end(payload);
    else if (url.pathname.endsWith("/SHA256SUMS")) {
      const digest = options.checksum ?? hash;
      response.end(options.star ? `${digest} *${archive}\n` : `${digest}  ${archive}\n`);
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  try {
    await Promise.all([apps, backups, bin, downloadTmp].map((path) => NodeFSP.mkdir(path)));
    if (options.locked) await NodeFSP.mkdir(NodePath.join(backups, ".updater-lock"));
    const bundle = NodePath.join(root, "bundle/Tx Code.app");
    await NodeFSP.mkdir(NodePath.join(bundle, "Contents/MacOS"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(bundle, "Contents/Resources"));
    await NodeFSP.writeFile(
      NodePath.join(bundle, "Contents/Info.plist"),
      JSON.stringify({
        CFBundleIdentifier: "net.coriou.txcode",
        CFBundleShortVersionString: version,
        CFBundleExecutable: "Tx Code",
      }),
    );
    await NodeFSP.writeFile(NodePath.join(bundle, "Contents/MacOS/Tx Code"), "fixture");
    await NodeFSP.writeFile(
      NodePath.join(bundle, "Contents/Resources/app.asar"),
      '{"t3codeCommitHash":"abcdef1234567890"}',
    );
    if (options.installed) {
      await NodeFSP.cp(
        bundle,
        NodePath.join(
          apps,
          options.installed === "nightly" ? "Tx Code (Nightly).app" : "Tx Code.app",
        ),
        { recursive: true },
      );
    }
    if (options.aside) {
      await NodeFSP.mkdir(NodePath.join(apps, "Tx Code.app.aside"));
      if (options.aside === "both") await NodeFSP.mkdir(NodePath.join(apps, "Tx Code.app"));
    }
    if (options.installed)
      await NodeFSP.writeFile(
        NodePath.join(
          apps,
          options.installed === "nightly"
            ? "Tx Code (Nightly).app/fixture-current"
            : "Tx Code.app/fixture-current",
        ),
        "current app",
      );
    const profile = NodePath.join(root, "home/.txcode");
    if (options.state) {
      await NodeFSP.mkdir(NodePath.join(profile, "userdata"), { recursive: true });
      await NodeFSP.mkdir(NodePath.join(profile, "worktrees/repo/branch/node_modules"), {
        recursive: true,
      });
      await NodeFSP.writeFile(
        NodePath.join(profile, "worktrees/repo/branch/node_modules/keep"),
        "current dependency",
      );
      await NodeFSP.writeFile(
        NodePath.join(profile, "userdata/settings.json"),
        JSON.stringify({
          worktreeOnDelete: true,
          projectSettingsOverrides: {
            p: { worktreeCleanup: { mode: "custom", rules: { worktreeOnDelete: true } } },
          },
        }),
      );
      const db = NodeChildProcess.spawnSync("python3", [
        "-c",
        "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('CREATE TABLE projection_projects (workspace_root TEXT)'); c.execute('INSERT INTO projection_projects VALUES (?)', (sys.argv[2],)); c.commit()",
        NodePath.join(profile, "userdata/statev2.sqlite"),
        NodePath.join(profile, "worktrees/repo/branch"),
      ]);
      if (db.status !== 0) throw new Error(db.stderr.toString());
    }
    const processes = NodePath.join(root, "processes");
    await NodeFSP.writeFile(
      processes,
      options.running
        ? `${apps}/Tx Code (Nightly).app/Contents/MacOS/Tx Code\n`
        : `/worktree/Tx Code.app/script\n/Applications/T3 Code.app/Contents/MacOS/T3 Code\n`,
    );
    const shim = NodePath.join(bin, "shim.cjs");
    await NodeFSP.writeFile(
      shim,
      `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const root = process.env.TXCODE_UPDATE_FIXTURE_ROOT;
fs.appendFileSync(path.join(root, 'calls'), name + ' ' + args.join(' ') + '\\n');
if (name === 'uname') console.log(args[0] === '-s' ? 'Darwin' : ${JSON.stringify(options.arm ? "arm64" : "x86_64")});
else if (name === 'curl') {
  const failure = ${JSON.stringify(options.transferFailure)};
  const url = args.find((arg) => arg.startsWith('http'));
  const selected = failure === 'lookup' ? url.includes('/releases?') : failure === 'dmg' ? url.endsWith('.dmg') : failure === 'checksum' && url.endsWith('/SHA256SUMS');
  if (selected && args.includes('--connect-timeout') && args.includes('--max-time')) process.exit(28);
  const result = require('node:child_process').spawnSync('/usr/bin/curl', args, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
else if (name === 'df') console.log('Filesystem 1024-blocks Used Available Capacity Mounted on\\nfixture 999999999 0 ${options.lowSpace ? 1 : 999999999} 0% /');
else if (name === 'launchctl') console.log('PID Status Label');
else if (name === 'plutil') {
  try {
    let value = JSON.parse(fs.readFileSync(args[args.length - 1], 'utf8'));
    for (const key of args[1].split('.')) value = value[key];
    if (value === undefined || value === null || typeof value === 'object') process.exit(1);
    // console.log colorizes booleans and numbers when FORCE_COLOR is set.
    process.stdout.write(String(value) + '\\n');
  } catch { process.exit(1); }
} else if (name === 'hdiutil' && args[0] === 'attach') {
  fs.cpSync(path.join(root, 'bundle'), args[args.indexOf('-mountpoint') + 1], { recursive: true });
} else if (name === 'ditto') {
  if (${Boolean(options.copyFailure)}) process.exit(1);
  fs.cpSync(args[0], args[1], { recursive: true });
}
else if (name === 'file') console.log('Mach-O 64-bit executable x86_64');
else if (name === 'open') process.exit(99);
`,
      { mode: 0o755 },
    );
    for (const name of [
      "df",
      "uname",
      "launchctl",
      "plutil",
      "hdiutil",
      "ditto",
      "file",
      "open",
      "curl",
    ]) {
      await NodeFSP.symlink(shim, NodePath.join(bin, name));
    }
    const manifest =
      [
        "tag\tvfixture",
        "sha256\tnone",
        "bundle-id\tnet.coriou.txcode",
        `version\t${version}`,
        "arch\tx86_64",
        "commit\tabcdef1",
        ...(options.forbidden ? [`source\t${options.forbidden}`] : []),
      ].join("\n") + "\n";
    if (options.backups || options.escape || options.forbidden || options.rollbackId) {
      for (const id of ["20260101T000000Z", "20260102T000000Z", "20260103T000000Z"]) {
        await NodeFSP.mkdir(NodePath.join(backups, id));
        await NodeFSP.writeFile(NodePath.join(backups, id, "BACKUP-MANIFEST.txt"), manifest);
        await NodeFSP.writeFile(NodePath.join(backups, id, "complete"), "");
      }
      await NodeFSP.mkdir(NodePath.join(backups, "20260104T000000Z"));
      if (options.escape) {
        const outside = NodePath.join(root, "outside-backups");
        await NodeFSP.mkdir(outside);
        await NodeFSP.writeFile(NodePath.join(outside, "BACKUP-MANIFEST.txt"), manifest);
        await NodeFSP.writeFile(NodePath.join(outside, "complete"), "");
        await NodeFSP.symlink(outside, NodePath.join(backups, "20260105T000000Z"));
      }
      if (options.rollbackId) {
        await NodeFSP.cp(bundle, NodePath.join(backups, options.rollbackId, "Tx Code.app"), {
          recursive: true,
        });
        await NodeFSP.writeFile(
          NodePath.join(backups, options.rollbackId, "BACKUP-MANIFEST.txt"),
          [
            "tag\tvfixture",
            "sha256\tnone",
            "bundle-id\tnet.coriou.txcode",
            `version\t${version}`,
            "arch\tx86_64",
            "commit\tabcdef1234567890",
            `source\t${NodePath.join(apps, "Tx Code.app")}`,
          ].join("\n") + "\n",
        );
      }
    }
    if (options.scopedBackups) {
      for (const id of ["20260101T000000Z", "20260102T000000Z", "20260103T000000Z"]) {
        const snapshot = NodePath.join(backups, id);
        await NodeFSP.appendFile(
          NodePath.join(snapshot, "BACKUP-MANIFEST.txt"),
          "format\tapplication-state-v2\n",
        );
        await NodeFSP.mkdir(NodePath.join(snapshot, "profile"));
        await NodeFSP.writeFile(
          NodePath.join(snapshot, "APPLICATION-STATE.json"),
          JSON.stringify({
            version: 2,
            entries: [],
            workspaces: [NodePath.join(profile, "worktrees")],
          }),
        );
      }
    }
    const desktop = NodePath.join(root, "home/Library/Application Support/txcode-v2");
    if (options.state) {
      await NodeFSP.mkdir(desktop, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(desktop, "fixture-state"), "current desktop");
    }
    if (options.scopedRollback && options.rollbackId) {
      const snapshot = NodePath.join(backups, options.rollbackId);
      await NodeFSP.appendFile(
        NodePath.join(snapshot, "BACKUP-MANIFEST.txt"),
        `format\tapplication-state-v2\nsource\t${profile}\n`,
      );
      await NodeFSP.cp(
        NodePath.join(profile, "userdata"),
        NodePath.join(snapshot, "profile/userdata"),
        { recursive: true },
      );
      await NodeFSP.writeFile(
        NodePath.join(snapshot, "APPLICATION-STATE.json"),
        JSON.stringify({
          version: 2,
          entries: ["userdata"],
          workspaces: [
            NodePath.join(profile, "worktrees"),
            NodePath.join(profile, "worktrees/repo/branch"),
          ],
        }),
      );
      await NodeFSP.appendFile(
        NodePath.join(snapshot, "BACKUP-MANIFEST.txt"),
        `source\t${desktop}\n`,
      );
      await NodeFSP.mkdir(NodePath.join(snapshot, "desktop"));
      await NodeFSP.writeFile(NodePath.join(snapshot, "desktop/fixture-state"), "old desktop");
      if (options.unsafeSnapshot) {
        const db = NodeChildProcess.spawnSync("python3", [
          "-c",
          "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('CREATE TABLE scheduled_tasks (enabled INTEGER)'); c.execute('INSERT INTO scheduled_tasks VALUES (1)'); c.commit()",
          NodePath.join(snapshot, "profile/userdata/statev2.sqlite"),
        ]);
        if (db.status !== 0) throw new Error(db.stderr.toString());
      }
    }
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture listener");
    const origin = `http://127.0.0.1:${address.port}`;
    const source = await NodeFSP.readFile(
      NodePath.join(import.meta.dirname, "update-txcode-macos.sh"),
      "utf8",
    );
    const script = NodePath.join(root, "update.sh");
    let scriptSource = source.replace(/https:\/\/(api\.)?github\.com/g, origin);
    if (options.crash) {
      const boundary =
        options.crash === "installed"
          ? `  identity "$destination" '' || fail 'Restored app identity failed; quarantine and aside retained.'`
          : '  state finish "$data1" "$backup"';
      scriptSource = scriptSource.replace(
        boundary,
        '  if [ ! -e "$sandbox/crash-used" ]; then touch "$sandbox/crash-used"; exit 97; fi\n' +
          boundary,
      );
    }
    if (options.crash)
      scriptSource = scriptSource.replace(
        '  state finish "$data1" "$quarantine"',
        '  if [ ! -e "$sandbox/recovery-crash-used" ]; then touch "$sandbox/recovery-crash-used"; exit 98; fi\n  state finish "$data1" "$quarantine"',
      );
    await NodeFSP.writeFile(script, scriptSource);
    const command = options.forbidden || options.rollbackId ? "rollback" : "update";
    const pty = NodePath.join(root, "terminal.py");
    await NodeFSP.writeFile(
      pty,
      `import os, pty, select, sys
cmd = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execv(cmd[0], cmd)
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
`,
    );
    const execute = () =>
      new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = NodeChildProcess.spawn(
          options.pipe ? "/bin/sh" : "python3",
          options.pipe ? [script] : [pty, "/bin/sh", script, command],
          {
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH}`,
              TMPDIR: downloadTmp,
              TXCODE_UPDATE_FIXTURE: "1",
              TXCODE_UPDATE_FIXTURE_ROOT: root,
              TXCODE_UPDATE_APPS: apps,
              TXCODE_UPDATE_BACKUPS: backups,
              TXCODE_UPDATE_PS: processes,
            },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        let output = "";
        let answered = 0;
        let sentId = false;
        const acceptCount = options.confirms ?? (options.rollbackId ? 1 : 2);
        const receive = (chunk: Buffer) => {
          output += chunk.toString();
          if (options.rollbackId && !sentId && output.includes("Type the backup id to restore: ")) {
            sentId = true;
            child.stdin.write(`${options.rollbackId}\n`);
          }
          const prompts = output.match(/\[y\/yes to continue\]:/g)?.length ?? 0;
          while (answered < prompts) {
            child.stdin.write(answered++ < acceptCount ? "yes\n" : "no\n");
          }
        };
        child.stdout.on("data", receive);
        child.stderr.on("data", receive);
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, output }));
      });
    const firstResult = await execute();
    const recoveryResults = [];
    const recoveryStates = [];
    if (options.crash) {
      for (const _attempt of [1, 2]) {
        recoveryResults.push(await execute());
        recoveryStates.push({
          apps: await NodeFSP.readdir(apps),
          marker: await NodeFSP.readFile(
            NodePath.join(
              apps,
              options.installed === "nightly"
                ? "Tx Code (Nightly).app/fixture-current"
                : "Tx Code.app/fixture-current",
            ),
            "utf8",
          ).catch(() => ""),
          settings: JSON.parse(
            await NodeFSP.readFile(NodePath.join(profile, "userdata/settings.json"), "utf8"),
          ),
          desktop: await NodeFSP.readFile(NodePath.join(desktop, "fixture-state"), "utf8").catch(
            () => "",
          ),
        });
      }
    }
    const result = firstResult;
    const names = await NodeFSP.readdir(backups);
    const newest = [...names].sort().at(-1);
    const previous = newest
      ? await NodeFSP.readdir(NodePath.join(backups, newest)).catch(() => [] as string[])
      : [];
    const leftovers = await NodeFSP.readdir(downloadTmp);
    if (leftovers.length > 0)
      throw new Error(`download directory left behind: ${leftovers.join(", ")}`);
    return {
      ...result,
      recoveryResults,
      recoveryStates,
      desktopMarker: await NodeFSP.readFile(NodePath.join(desktop, "fixture-state"), "utf8").catch(
        () => "",
      ),
      appMarker: await NodeFSP.readFile(
        NodePath.join(
          apps,
          options.installed === "nightly"
            ? "Tx Code (Nightly).app/fixture-current"
            : "Tx Code.app/fixture-current",
        ),
        "utf8",
      ).catch(() => ""),
      transactionPresent: await NodeFSP.stat(NodePath.join(backups, ".restore-journal.json"))
        .then(() => true)
        .catch(() => false),
      requests,
      calls: await NodeFSP.readFile(NodePath.join(root, "calls"), "utf8").catch(() => ""),
      backups: names,
      apps: await NodeFSP.readdir(apps),
      previous,
      savedProfile: newest
        ? await NodeFSP.readdir(NodePath.join(backups, newest, "profile")).catch(() => [])
        : [],
      workspace: await NodeFSP.readFile(
        NodePath.join(profile, "worktrees/repo/branch/node_modules/keep"),
        "utf8",
      ).catch(() => ""),
      restoredSettings: await NodeFSP.readFile(
        NodePath.join(profile, "userdata/settings.json"),
        "utf8",
      ).catch(() => ""),
      restoredDatabase: await NodeFSP.readFile(NodePath.join(profile, "userdata/statev2.sqlite"))
        .then((v) => v.subarray(0, 16).toString())
        .catch(() => ""),
      stateManifest: newest
        ? await NodeFSP.readFile(
            NodePath.join(backups, newest, "APPLICATION-STATE.json"),
            "utf8",
          ).catch(() => "")
        : "",
    };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

it("chooses the newest qualifying nightly while retaining legacy full-profile backups", async () => {
  const result = await fixture({ backups: true });
  expect(result.code, result.output).toBe(0);
  expect(result.requests).toEqual([
    "/repos/Coriou/txcode/releases",
    `/Coriou/txcode/releases/download/v${version}/${archive}`,
    `/Coriou/txcode/releases/download/v${version}/SHA256SUMS`,
  ]);
  expect(result.apps).toEqual(["Tx Code.app"]);
  expect(result.backups).toContain("20260101T000000Z");
  expect(result.backups).toContain("20260102T000000Z");
  expect(result.backups).toContain("20260103T000000Z");
  expect(result.backups).toContain("20260104T000000Z");
  expect(result.backups).toHaveLength(5);
  expect(result.calls).not.toContain("open ");
  expect(result.output.split(`Removed download ${archive}`)).toHaveLength(2);
});
it("never downloads an Intel DMG on Apple Silicon", async () => {
  const result = await fixture({ arm: true });
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("Apple Silicon builds are not published yet");
  expect(result.requests).toHaveLength(1);
});
it("rejects a checksum mismatch before mounting or copying", async () => {
  const result = await fixture({ checksum: "0".repeat(64) });
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("Checksum mismatch");
  expect(result.output).toContain(`Removed download ${archive}`);
  expect(result.calls).not.toMatch(/hdiutil|ditto/);
});
it("removes the download when the swap is declined", async () => {
  const result = await fixture({ confirms: 1 });
  expect(result.code, result.output).not.toBe(0);
  expect(result.output).toContain("Aborted.");
  expect(result.output).toContain(`Removed download ${archive}`);
  expect(result.calls).not.toContain("ditto");
  expect(result.apps).toHaveLength(0);
});
it("refuses running app executables before downloading", async () => {
  const result = await fixture({ running: true });
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("Cmd+Q");
  expect(result.requests).toHaveLength(0);
});
it("refuses symlink backups before pruning", async () => {
  const result = await fixture({ escape: true });
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("Backup symlink refused");
  expect(result.backups).toContain("20260101T000000Z");
  expect(result.apps).toHaveLength(0);
});
it.each(["/home/fixture/.t3", "/home/fixture/Library/Application Support/t3code-v2"])(
  "rejects a manifest naming %s",
  async (forbidden) => {
    const result = await fixture({ forbidden });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("Invalid manifest or forbidden source path");
    expect(result.calls).not.toContain("ditto");
  },
);
it("requires terminal stdin even in fixture mode", async () => {
  const result = await fixture({ pipe: true });
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("terminal on stdin");
});
it("accepts the star checksum form", async () => {
  const result = await fixture({ star: true });
  expect(result.code, result.output).toBe(0);
  expect(result.calls).not.toContain("open ");
});
it("stores the previous app in the backup and leaves no aside bundle", async () => {
  const result = await fixture({ installed: true });
  expect(result.code, result.output).toBe(0);
  expect(result.apps).toEqual(["Tx Code.app"]);
  expect(result.previous).toContain("Tx Code.app");
  expect(result.previous).not.toContain("displaced");
});
it("restores an interrupted aside bundle and stops", async () => {
  const result = await fixture({ aside: "only" });
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("Restored");
  expect(result.requests).toHaveLength(0);
  expect(result.apps).toEqual(["Tx Code.app"]);
});
it("deletes nothing when an interrupted swap left both bundles", async () => {
  const result = await fixture({ aside: "both" });
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("Nothing was deleted");
  expect(result.requests).toHaveLength(0);
  expect([...result.apps].sort()).toEqual(["Tx Code.app", "Tx Code.app.aside"]);
});
it("refuses automatic legacy full-profile restoration without changing current workspaces or backups", async () => {
  const result = await fixture({ state: true, installed: true, rollbackId: "20260103T000000Z" });
  expect(result.code).not.toBe(0);
  expect(result.output).toContain(
    "Legacy full-profile rollback requires offline scoped conversion",
  );
  expect(result.apps).toEqual(["Tx Code.app"]);
  expect(result.backups).toEqual([
    "20260101T000000Z",
    "20260102T000000Z",
    "20260103T000000Z",
    "20260104T000000Z",
  ]);
  expect(result.workspace).toBe("current dependency");
  expect(result.calls).not.toContain("ditto ");
  expect(result.calls).not.toContain("open ");
});

it("upgrades the legacy nightly bundle to Tx Code.app", async () => {
  const result = await fixture({ installed: "nightly" });
  expect(result.code, result.output).toBe(0);
  expect(result.apps).toEqual(["Tx Code.app"]);
  expect(result.previous).toContain("Tx Code (Nightly).app");
});

it.each([
  ["lookup", "Release lookup failed"],
  ["dmg", "DMG download failed"],
  ["checksum", "Checksum download failed"],
] as const)(
  "aborts a bounded %s transfer failure before copying",
  async (transferFailure, message) => {
    const result = await fixture({ transferFailure, installed: true });
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain(message);
    expect(result.calls).not.toMatch(/hdiutil|ditto|open /);
    expect(result.calls).toContain("--connect-timeout 15 --max-time 900");
    expect(result.apps).toEqual(["Tx Code.app"]);
    expect(result.backups).toEqual([]);
  },
);
it("reports a completed installation separately when launch fails", async () => {
  const result = await fixture({ installed: true, confirms: 3 });
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain("Installed:");
  expect(result.output).toContain("Launch request failed; the installed app and backup were kept");
  expect(result.apps).toEqual(["Tx Code.app"]);
  expect(result.previous).toContain("Tx Code.app");
  expect(result.previous).toContain("complete");
});

it("refuses insufficient space before creating a snapshot or copying", async () => {
  const result = await fixture({ lowSpace: true, installed: true });
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("Insufficient free space");
  expect(result.backups).toEqual([]);
  expect(result.calls).not.toContain("ditto ");
  expect(result.apps).toEqual(["Tx Code.app"]);
});

it("retains an incomplete snapshot on copy failure without swapping or pruning", async () => {
  const result = await fixture({ copyFailure: true, installed: true, backups: true });
  expect(result.code).not.toBe(0);
  expect(result.previous).not.toContain("complete");
  expect(result.backups).toContain("20260101T000000Z");
  expect(result.apps).toEqual(["Tx Code.app"]);
});

it("refuses an existing updater lock without removing it", async () => {
  const result = await fixture({ locked: true, installed: true });
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("Another updater or interrupted run");
  expect(result.backups).toEqual([".updater-lock"]);
  expect(result.calls).not.toContain("ditto ");
});

it("snapshots application state with a real SQLite database and retains workspace dependencies in place", async () => {
  const result = await fixture({ state: true, installed: true });
  expect(result.code, result.output).toBe(0);
  expect(result.savedProfile).toEqual(["userdata"]);
  expect(result.workspace).toBe("current dependency");
  expect(JSON.parse(result.stateManifest)).toMatchObject({ version: 2, entries: ["userdata"] });
  expect(result.calls).not.toMatch(/ditto .*worktrees/);
});

it("rolls back scoped state while preserving workspace files and disabling cleanup in old-app settings", async () => {
  const result = await fixture({
    state: true,
    scopedRollback: true,
    rollbackId: "20260103T000000Z",
    installed: true,
  });
  expect(result.code, result.output).toBe(0);
  expect(result.workspace).toBe("current dependency");
  expect(result.restoredDatabase).toBe("SQLite format 3\0");
  expect(JSON.parse(result.restoredSettings)).toMatchObject({
    worktreeCleanup: { mode: "off" },
    worktreeOnDelete: false,
    continueThreadsAfterServerUpdate: false,
    projectSettingsOverrides: { p: { worktreeCleanup: { mode: "off" } } },
  });
  expect(result.output).toContain("remains stopped");
  expect(result.calls).not.toContain("open ");
});
it("blocks rollback with enabled historical schedules before quarantining or replacing state", async () => {
  const result = await fixture({
    state: true,
    scopedRollback: true,
    unsafeSnapshot: true,
    rollbackId: "20260103T000000Z",
    installed: true,
  });
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("enabled schedules or pending effects");
  expect(result.workspace).toBe("current dependency");
  expect(JSON.parse(result.restoredSettings).worktreeOnDelete).toBe(true);
  expect(result.calls).not.toContain("ditto ");
});

it("recovers a partially moved scoped restore without moving surviving or newly created workspaces", async () => {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "txcode-state-test-")),
  );
  try {
    const source = await NodeFSP.readFile(
      NodePath.join(import.meta.dirname, "update-txcode-macos.sh"),
      "utf8",
    );
    const helper = source.split("<<'TXCODE_STATE_PY'\n")[1]?.split("\nTXCODE_STATE_PY")[0];
    if (!helper) throw new Error("Embedded state helper missing");
    const profile = NodePath.join(root, "home/.txcode");
    const backups = NodePath.join(root, "backups");
    const selected = NodePath.join(backups, "20260101T000000Z");
    const quarantine = NodePath.join(backups, "20260102T000000Z");
    const workspace = NodePath.join(profile, "worktrees/repo/branch");
    const external = NodePath.join(root, "external/repo/branch");
    await NodeFSP.mkdir(NodePath.join(profile, "userdata"), { recursive: true });
    await NodeFSP.mkdir(workspace, { recursive: true });
    await NodeFSP.mkdir(external, { recursive: true });
    await NodeFSP.symlink(
      NodePath.join(root, "external"),
      NodePath.join(profile, "linked-workspaces"),
    );
    await NodeFSP.writeFile(NodePath.join(profile, "unknown"), "current unknown state");
    await NodeFSP.writeFile(
      NodePath.join(profile, "userdata/settings.json"),
      JSON.stringify({ worktreesDirectory: NodePath.join(root, "external") }),
    );
    await NodeFSP.writeFile(
      NodePath.join(workspace, "ignored-irreplaceable"),
      "keep ignored bytes",
    );
    await NodeFSP.writeFile(NodePath.join(external, "uncommitted"), "keep external bytes");
    await NodeFSP.mkdir(selected, { recursive: true });
    await NodeFSP.mkdir(quarantine);
    const run = (operation: string, backup: string, extra: string[] = [], injected = "") =>
      NodeChildProcess.spawnSync(
        "python3",
        ["-c", injected + helper, operation, profile, backup, ...extra],
        { encoding: "utf8" },
      );
    expect(run("snapshot", selected).status).toBe(0);
    await NodeFSP.mkdir(NodePath.join(profile, "worktrees/new-repo/new-branch"), {
      recursive: true,
    });
    await NodeFSP.writeFile(
      NodePath.join(profile, "userdata/current-only"),
      "current application bytes",
    );
    expect(run("stage", selected, [quarantine]).status).toBe(0);
    // Inject an I/O failure at the filesystem boundary after the first entry moved.
    const injection = `import pathlib\n_original_rename = pathlib.Path.rename\ndef _rename(self, target):\n    if self.name == 'userdata' and str(target).endswith('/displaced-profile/userdata'): raise OSError('fixture move failure')\n    return _original_rename(self, target)\npathlib.Path.rename = _rename\n`;
    const failed = run("restore", quarantine, [selected], injection);
    expect(failed.status, failed.stderr).toBe(1);
    expect(failed.stderr).toContain("fixture move failure");
    const recovered = run("recover-data", backups);
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(recovered.stdout).toContain("Recovered application state");
    expect(run("finish", quarantine).status).toBe(0);
    expect(await NodeFSP.readFile(NodePath.join(profile, "unknown"), "utf8")).toBe(
      "current unknown state",
    );
    expect(await NodeFSP.readFile(NodePath.join(profile, "userdata/current-only"), "utf8")).toBe(
      "current application bytes",
    );
    expect(await NodeFSP.readFile(NodePath.join(workspace, "ignored-irreplaceable"), "utf8")).toBe(
      "keep ignored bytes",
    );
    expect(await NodeFSP.readFile(NodePath.join(external, "uncommitted"), "utf8")).toBe(
      "keep external bytes",
    );
    expect(await NodeFSP.readlink(NodePath.join(profile, "linked-workspaces"))).toBe(
      NodePath.join(root, "external"),
    );
    expect(
      (await NodeFSP.stat(NodePath.join(profile, "worktrees/new-repo/new-branch"))).isDirectory(),
    ).toBe(true);
    expect(await NodeFSP.readdir(NodePath.join(selected, "profile"))).toEqual([
      "unknown",
      "userdata",
    ]);
    const absentProfile = profile;
    await NodeFSP.rename(
      NodePath.join(profile, "userdata"),
      NodePath.join(root, "preserved-userdata"),
    );
    await NodeFSP.rename(
      NodePath.join(profile, "unknown"),
      NodePath.join(root, "preserved-unknown"),
    );
    const absentQuarantine = NodePath.join(backups, "20260103T000000Z");
    await NodeFSP.mkdir(absentQuarantine);
    const absent = (operation: string, backup: string, extra: string[] = []) =>
      NodeChildProcess.spawnSync(
        "python3",
        ["-c", helper, operation, absentProfile, backup, ...extra],
        { encoding: "utf8" },
      );
    expect(absent("stage", selected, [absentQuarantine]).status).toBe(0);
    expect(absent("restore", absentQuarantine, [selected]).status).toBe(0);
    expect((await NodeFSP.stat(NodePath.join(absentProfile, "userdata"))).isDirectory()).toBe(true);
    expect(absent("recover-data", backups).stdout).toContain("Recovered application state");
    expect(absent("finish", absentQuarantine).status).toBe(0);
    expect(await NodeFSP.readdir(absentProfile)).toEqual(["linked-workspaces", "worktrees"]);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it.each([
  ["workspace", false],
  ["workspace", true],
  ["desktop-overlap", false],
  ["desktop-ancestor-overlap", false],
  ["desktop-symlink-overlap", false],
  ["app-overlap", false],
  ["backup-overlap", false],
  ["scheduled_tasks", false],
  ["scheduled_tasks", true],
  ["outbox", false],
  ["outbox", true],
  ["unknown-schema", false],
  ["unknown-schema", true],
] as const)("inspects legacy state.sqlite (%s, empty v2=%s)", async (scenario, emptyV2) => {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "txcode-legacy-state-test-")),
  );
  try {
    const source = await NodeFSP.readFile(
      NodePath.join(import.meta.dirname, "update-txcode-macos.sh"),
      "utf8",
    );
    const helper = source.split("<<'TXCODE_STATE_PY'\n")[1]?.split("\nTXCODE_STATE_PY")[0];
    if (!helper) throw new Error("Embedded state helper missing");
    const profile = NodePath.join(root, "profile");
    await NodeFSP.mkdir(NodePath.join(profile, "userdata"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(profile, "custom-repo"));
    await NodeFSP.writeFile(
      NodePath.join(profile, "custom-repo/ignored-irreplaceable"),
      "surviving workspace bytes",
    );
    const setup = NodeChildProcess.spawnSync("python3", [
      "-c",
      `import pathlib,sqlite3,sys
profile=pathlib.Path(sys.argv[1])
c=sqlite3.connect(profile/'userdata/state.sqlite')
if sys.argv[2]=='unknown-schema': c.execute('CREATE TABLE historical_projects (root TEXT)')
else:
 c.execute('CREATE TABLE projection_projects (workspace_root TEXT)')
 workspace=profile/'custom-repo'
 if sys.argv[2]=='desktop-overlap': workspace=profile.parent/'Library/Application Support/txcode-v2/project'
 if sys.argv[2]=='desktop-ancestor-overlap': workspace=profile.parent
 if sys.argv[2]=='desktop-symlink-overlap':
  alias=profile.parent/'desktop-link'
  alias.symlink_to(profile.parent/'Library/Application Support/txcode-v2')
  workspace=alias/'project'
 if sys.argv[2]=='app-overlap': workspace=profile.parent/'Applications/Tx Code.app/project'
 if sys.argv[2]=='backup-overlap': workspace=profile.parent/'backup/project'
 c.execute('INSERT INTO projection_projects VALUES (?)', (str(workspace),))
 if sys.argv[2]=='scheduled_tasks':
  c.execute('CREATE TABLE scheduled_tasks (enabled INTEGER)')
  c.execute('INSERT INTO scheduled_tasks VALUES (1)')
 if sys.argv[2]=='outbox':
  c.execute('CREATE TABLE orchestration_v2_effect_outbox (status TEXT)')
  c.execute("INSERT INTO orchestration_v2_effect_outbox VALUES ('pending')")
c.commit(); c.close()
if sys.argv[3]=='true': sqlite3.connect(profile/'userdata/statev2.sqlite').close()
`,
      profile,
      scenario,
      String(emptyV2),
    ]);
    expect(setup.status, setup.stderr.toString()).toBe(0);
    const operation =
      scenario === "workspace" || scenario === "unknown-schema" || scenario.endsWith("-overlap")
        ? "plan"
        : "check-work";
    const backup = NodePath.join(root, "backup");
    await NodeFSP.mkdir(backup);
    await NodeFSP.cp(profile, NodePath.join(backup, "profile"), { recursive: true });
    const result = NodeChildProcess.spawnSync(
      "python3",
      ["-c", helper, operation, profile, backup],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          TXCODE_STATE_APPS: NodePath.join(root, "Applications"),
          TXCODE_STATE_BACKUPS: backup,
        },
      },
    );
    if (scenario === "workspace") {
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual([NodePath.join(profile, "userdata")]);
    } else {
      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).toContain(
        scenario.endsWith("-overlap")
          ? "Workspace overlaps updater-managed path"
          : scenario === "unknown-schema"
            ? "Unsupported application database schema"
            : "enabled schedules or pending effects",
      );
    }
    expect(
      await NodeFSP.readFile(NodePath.join(profile, "custom-repo/ignored-irreplaceable"), "utf8"),
    ).toBe("surviving workspace bytes");
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it.each([
  ["installed", true],
  ["installed", "nightly"],
  ["installed", false],
  ["displaced", true],
  ["displaced", "nightly"],
  ["displaced", false],
] as const)(
  "recovers matching original app and data after crash at %s boundary (original=%s)",
  async (crash, installed) => {
    const result = await fixture({
      crash,
      state: true,
      scopedRollback: true,
      rollbackId: "20260103T000000Z",
      installed,
    });
    expect(result.code, result.output).toBe(97);
    expect(result.recoveryResults[0]?.code, result.recoveryResults[0]?.output).toBe(98);
    expect(result.recoveryResults[1]?.output).toContain(
      "Recovered original app and application state",
    );
    expect(result.appMarker).toBe(installed ? "current app" : "");
    expect(result.apps).toEqual(
      installed ? [installed === "nightly" ? "Tx Code (Nightly).app" : "Tx Code.app"] : [],
    );
    for (const state of result.recoveryStates) {
      expect(state.apps).toEqual(
        installed ? [installed === "nightly" ? "Tx Code (Nightly).app" : "Tx Code.app"] : [],
      );
      expect(state.marker).toBe(installed ? "current app" : "");
      expect(state.settings.worktreeOnDelete).toBe(true);
      expect(state.desktop).toBe("current desktop");
    }
    expect(result.transactionPresent).toBe(false);
    expect(result.desktopMarker).toBe("current desktop");
    expect(JSON.parse(result.restoredSettings).worktreeOnDelete).toBe(true);
    expect(result.workspace).toBe("current dependency");
  },
);
it("validates and prunes superseded scoped snapshots after a successful update", async () => {
  const result = await fixture({ backups: true, scopedBackups: true });
  expect(result.code, result.output).toBe(0);
  expect(result.backups).not.toContain("20260101T000000Z");
  expect(result.backups).not.toContain("20260102T000000Z");
  expect(result.backups).not.toContain("20260103T000000Z");
  expect(result.backups).toHaveLength(2);
});
