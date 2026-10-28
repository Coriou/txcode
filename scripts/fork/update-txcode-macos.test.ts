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
    arm?: boolean;
    running?: boolean;
    checksum?: string;
    star?: boolean;
    backups?: boolean;
    escape?: boolean;
    forbidden?: string;
    pipe?: boolean;
    aside?: "only" | "both";
    installed?: boolean | "nightly";
    rollbackId?: string;
    confirms?: number;
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
} else if (name === 'ditto') fs.cpSync(args[0], args[1], { recursive: true });
else if (name === 'file') console.log('Mach-O 64-bit executable x86_64');
else if (name === 'open') process.exit(99);
`,
      { mode: 0o755 },
    );
    for (const name of ["uname", "launchctl", "plutil", "hdiutil", "ditto", "file", "open"]) {
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
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture listener");
    const origin = `http://127.0.0.1:${address.port}`;
    const source = await NodeFSP.readFile(
      NodePath.join(import.meta.dirname, "update-txcode-macos.sh"),
      "utf8",
    );
    const script = NodePath.join(root, "update.sh");
    await NodeFSP.writeFile(script, source.replace(/https:\/\/(api\.)?github\.com/g, origin));
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
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
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
      requests,
      calls: await NodeFSP.readFile(NodePath.join(root, "calls"), "utf8").catch(() => ""),
      backups: names,
      apps: await NodeFSP.readdir(apps),
      previous,
    };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

it("chooses the newest qualifying nightly and keeps one complete backup", async () => {
  const result = await fixture({ backups: true });
  expect(result.code, result.output).toBe(0);
  expect(result.requests).toEqual([
    "/repos/Coriou/txcode/releases",
    `/Coriou/txcode/releases/download/v${version}/${archive}`,
    `/Coriou/txcode/releases/download/v${version}/SHA256SUMS`,
  ]);
  expect(result.apps).toEqual(["Tx Code.app"]);
  expect(result.backups).not.toContain("20260101T000000Z");
  expect(result.backups).not.toContain("20260102T000000Z");
  expect(result.backups).not.toContain("20260103T000000Z");
  expect(result.backups).toContain("20260104T000000Z");
  expect(result.backups).toHaveLength(2);
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
it("restores a snapshot after quarantining the current install", async () => {
  const result = await fixture({ rollbackId: "20260103T000000Z" });
  expect(result.code, result.output).toBe(0);
  expect(result.apps).toEqual(["Tx Code.app"]);
  expect(result.backups).not.toContain("20260101T000000Z");
  expect(result.backups).not.toContain("20260102T000000Z");
  expect(result.backups).not.toContain("20260103T000000Z");
  expect(result.backups).toContain("20260104T000000Z");
  expect(result.backups).toHaveLength(2);
  expect(result.calls).not.toContain("open ");
});

it("upgrades the legacy nightly bundle to Tx Code.app", async () => {
  const result = await fixture({ installed: "nightly" });
  expect(result.code, result.output).toBe(0);
  expect(result.apps).toEqual(["Tx Code.app"]);
  expect(result.previous).toContain("Tx Code (Nightly).app");
});
