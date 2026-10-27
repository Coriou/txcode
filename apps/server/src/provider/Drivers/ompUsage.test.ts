// @effect-diagnostics nodeBuiltinImport:off - exercise the real byte reader.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { OmpSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as HostProcess from "@t3tools/shared/HostProcess";

import { readTranscriptRecords } from "../../usage/usageTranscriptReader.ts";
import { ompUsageDirectories, ompUsageFormat } from "./ompUsage.ts";

type ScanState = { sessionId: string };

const initial = (): ScanState => ({ sessionId: "" });

const session = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-10-24T13:58:52.043Z",
    ...extra,
  });

const assistant = (overrides: {
  readonly id: string;
  readonly timestamp?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly usage?: Record<string, unknown>;
}) =>
  JSON.stringify({
    type: "message",
    id: overrides.id,
    parentId: null,
    timestamp: overrides.timestamp ?? "2026-10-24T13:59:10.287Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      provider: overrides.provider ?? "openrouter",
      model: overrides.model ?? "z-ai/glm-5.3-flash",
      usage: overrides.usage ?? {
        input: 2_400,
        output: 425,
        cacheRead: 24_320,
        cacheWrite: 8,
        totalTokens: 27_153,
        reasoningTokens: 76,
        cost: {
          input: 0.0003,
          output: 0.0002,
          cacheRead: 0.00006,
          cacheWrite: 0.0004,
          total: 0.001,
        },
      },
    },
  });

function scan(lines: readonly string[], state: ScanState = initial()) {
  const records = lines.flatMap((line) => ompUsageFormat.parseLine(line, state));
  return { records, state };
}

describe("ompUsageFormat", () => {
  it("attributes assistant token and cost totals to the session header", () => {
    const { records, state } = scan([session("01a16e35"), assistant({ id: "a1" })]);

    expect(state.sessionId).toBe("01a16e35");
    expect(records).toEqual([
      {
        provider: "omp",
        timestampMs: Date.parse("2026-10-24T13:59:10.287Z"),
        model: "openrouter/z-ai/glm-5.3-flash",
        rateModel: "z-ai/glm-5.3-flash",
        sessionId: "01a16e35",
        totals: {
          uncachedInputTokens: 2_400,
          cachedInputTokens: 24_320,
          cacheCreationTokens: 8,
          outputTokens: 425,
          reasoningTokens: 76,
        },
        reportedCostUsd: 0.001,
        speed: "standard",
        dedupeKey: JSON.stringify([
          "omp",
          "a1",
          "2026-10-24T13:59:10.287Z",
          "openrouter/z-ai/glm-5.3-flash",
        ]),
      },
    ]);
  });

  it("keeps tokens but leaves cost to T3 estimates when OMP had no price", () => {
    const { records } = scan([
      session("s1"),
      assistant({ id: "a1", usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 } }),
      assistant({
        id: "a2",
        usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
      }),
    ]);

    expect(records.map((record) => record.reportedCostUsd)).toEqual([null, null]);
    expect(records.map((record) => record.totals.outputTokens)).toEqual([2, 2]);
  });

  it("ignores task subagent aggregates because child sessions report their own spend", () => {
    const taskResult = JSON.stringify({
      type: "message",
      id: "t1",
      timestamp: "2026-10-24T14:00:00.000Z",
      message: {
        role: "toolResult",
        toolName: "task",
        content: [],
        details: { results: [], usage: { input: 5, output: 5, cost: { total: 3 } } },
      },
    });

    expect(scan([session("s1"), taskResult]).records).toEqual([]);
  });

  it("skips entries that carry no usage", () => {
    const userMessage = JSON.stringify({
      type: "message",
      id: "u1",
      timestamp: "2026-10-24T13:58:53.000Z",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    });
    const modelChange = JSON.stringify({
      type: "model_change",
      id: "m1",
      timestamp: "2026-10-24T13:58:52.817Z",
      model: "openrouter/z-ai/glm-5.3-flash",
    });

    expect(scan([session("s1"), userMessage, modelChange, "{not json"]).records).toEqual([]);
  });

  it("keeps a subagent session's spend apart while a copied fork entry dedupes", () => {
    const parentEntry = assistant({ id: "a1" });
    const { records } = scan([
      session("parent"),
      parentEntry,
      session("child", { parentSession: "/sessions/parent.jsonl" }),
      assistant({ id: "c1", timestamp: "2026-10-24T14:01:00.000Z" }),
      session("fork"),
      parentEntry,
    ]);

    expect(records.map((record) => record.sessionId)).toEqual(["parent", "child", "fork"]);
    // The fork wrote the same entry verbatim, so one key covers both copies; the child is distinct spend.
    expect(records[2]?.dedupeKey).toBe(records[0]?.dedupeKey);
    expect(records[1]?.dedupeKey).not.toBe(records[0]?.dedupeKey);
  });
});

const readersLayer = NodeServices.layer;
const decodeSettings = Schema.decodeSync(OmpSettings);

function directories(environment: NodeJS.ProcessEnv, home: string, launchArgs = "") {
  return ompUsageDirectories({
    config: decodeSettings({ launchArgs }),
    environment,
  }).pipe(
    Effect.provideService(HostProcess.HomeDirectory, home),
    Effect.provideService(HostProcess.Platform, "darwin"),
  );
}

describe("ompUsageDirectories", () => {
  it.effect("defaults to ~/.omp/agent/sessions", () =>
    Effect.gen(function* () {
      expect(yield* directories({}, "/home/tester")).toEqual([
        { dir: "/home/tester/.omp/agent/sessions" },
      ]);
    }).pipe(Effect.provide(readersLayer)),
  );

  it.effect("follows PI_CODING_AGENT_DIR, expanding a leading ~ as the other readers do", () =>
    Effect.gen(function* () {
      expect(yield* directories({ PI_CODING_AGENT_DIR: "~/omp-agent" }, "/home/tester")).toEqual([
        { dir: "/home/tester/omp-agent/sessions" },
      ]);
    }).pipe(Effect.provide(readersLayer)),
  );

  it.effect("reads a launch-argument profile store, which outranks PI_CODING_AGENT_DIR", () =>
    Effect.gen(function* () {
      expect(
        yield* directories({ PI_CODING_AGENT_DIR: "/srv/agent" }, "/home/tester", "--profile work"),
      ).toEqual([{ dir: "/home/tester/.omp/profiles/work/agent/sessions" }]);
      expect(
        yield* directories({ OMP_PROFILE: "work" }, "/home/tester", "--profile default"),
      ).toEqual([{ dir: "/home/tester/.omp/agent/sessions" }]);
    }).pipe(Effect.provide(readersLayer)),
  );

  it.effect("resolves OMP_PROFILE, including its default-profile sentinels", () =>
    Effect.gen(function* () {
      expect(yield* directories({ OMP_PROFILE: "work" }, "/home/tester")).toEqual([
        { dir: "/home/tester/.omp/profiles/work/agent/sessions" },
      ]);
      expect(
        yield* directories({ OMP_PROFILE: "default", PI_PROFILE: "work" }, "/home/tester"),
      ).toEqual([{ dir: "/home/tester/.omp/agent/sessions" }]);
      expect(yield* directories({ OMP_PROFILE: "", PI_PROFILE: "work" }, "/home/tester")).toEqual([
        { dir: "/home/tester/.omp/agent/sessions" },
      ]);
    }).pipe(Effect.provide(readersLayer)),
  );

  it.effect("renames the config root with PI_CONFIG_DIR", () =>
    Effect.gen(function* () {
      expect(yield* directories({ PI_CONFIG_DIR: ".omp-canary" }, "/home/tester")).toEqual([
        { dir: "/home/tester/.omp-canary/agent/sessions" },
      ]);
    }).pipe(Effect.provide(readersLayer)),
  );

  it.effect("prefers an explicit session directory over the agent directory", () =>
    Effect.gen(function* () {
      expect(
        yield* directories(
          { PI_CODING_AGENT_DIR: "/srv/agent", PI_CODING_AGENT_SESSION_DIR: "/srv/sessions" },
          "/home/tester",
        ),
      ).toEqual([{ dir: "/srv/sessions" }]);
      expect(
        yield* directories(
          { PI_CODING_AGENT_SESSION_DIR: "/srv/sessions" },
          "/home/tester",
          "--session-dir /srv/run",
        ),
      ).toEqual([{ dir: "/srv/run" }]);
      expect(yield* directories({}, "/home/tester", "--session-dir=/srv/equals")).toEqual([
        { dir: "/srv/equals" },
      ]);
    }).pipe(Effect.provide(readersLayer)),
  );

  it.effect("prefers a migrated XDG root over the legacy home", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const migrated = yield* fileSystem.makeTempDirectoryScoped({ prefix: "omp-usage-xdg-" });
      yield* fileSystem.makeDirectory(`${migrated}/omp`);
      const notMigrated = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "omp-usage-no-xdg-",
      });

      expect(yield* directories({ XDG_DATA_HOME: migrated }, "/home/tester")).toEqual([
        { dir: path.join(migrated, "omp", "sessions") },
      ]);

      yield* fileSystem.makeDirectory(`${migrated}/omp/profiles/work`, { recursive: true });
      expect(
        yield* directories({ XDG_DATA_HOME: migrated, OMP_PROFILE: "work" }, "/home/tester"),
      ).toEqual([{ dir: path.join(migrated, "omp", "profiles", "work", "sessions") }]);
      expect(yield* directories({ XDG_DATA_HOME: notMigrated }, "/home/tester")).toEqual([
        { dir: "/home/tester/.omp/agent/sessions" },
      ]);
    }).pipe(Effect.provide(readersLayer)),
  );
});

describe("ompUsageReader transcripts", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-usage-"));
  });
  afterEach(async () => {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  });

  const largeEntry = (text: string) =>
    JSON.stringify({
      type: "message",
      id: "a123abcd",
      timestamp: "2026-08-01T10:00:00Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        provider: "openrouter",
        model: "z-ai/glm-5.3-flash",
        usage: { input: 100, output: 99, cost: { total: 0.25 } },
      },
    });

  it("projects lines larger than the streaming threshold identically", async () => {
    const path = NodePath.join(dir, "large.jsonl");
    const body = '工具 output \\" usage token_count '.repeat(40_000);
    await NodeFSP.writeFile(path, [session("omp-session"), largeEntry(body)].join("\n") + "\n");

    const projected = await readTranscriptRecords(path, ompUsageFormat, undefined, {
      streamingThresholdBytes: 1_024,
    });
    const linewise = await readTranscriptRecords(path, ompUsageFormat, undefined, {
      streamingThresholdBytes: 64 * 1_024 * 1_024,
    });

    expect(projected?.records).toEqual(linewise?.records);
    expect(projected?.position.state).toEqual({ sessionId: "omp-session" });
    expect(projected?.records[0]).toMatchObject({
      sessionId: "omp-session",
      rateModel: "z-ai/glm-5.3-flash",
      reportedCostUsd: 0.25,
    });
  });

  it("resumes an OMP session header so appended messages keep their session", async () => {
    const path = NodePath.join(dir, "resume.jsonl");
    await NodeFSP.writeFile(path, session("omp-session") + "\n");
    const header = await readTranscriptRecords(path, ompUsageFormat);
    expect(header?.records).toEqual([]);

    await NodeFSP.appendFile(
      path,
      JSON.stringify({
        type: "message",
        id: "a1",
        timestamp: "2026-08-01T10:00:00Z",
        message: {
          role: "assistant",
          provider: "openrouter",
          model: "z-ai/glm-5.3-flash",
          usage: { input: 7, output: 3, cost: { total: 0.5 } },
        },
      }) + "\n",
    );

    const grown = await readTranscriptRecords(path, ompUsageFormat, header!.position);
    expect(grown?.records).toHaveLength(1);
    expect(grown?.records[0]).toMatchObject({ sessionId: "omp-session", reportedCostUsd: 0.5 });
  });
});
