// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  OmpSettings,
  EnvironmentId,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  ProjectId,
  RunId,
  RunAttemptId,
  NodeId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as EventStore from "../EventStore.ts";
import * as EventSink from "../EventSink.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as LegacyImporter from "../legacy/LegacyV1ThreadImporter.ts";
import { shouldPrepareLegacyImportHandoff } from "../Orchestrator.ts";
import { ChildProcessSpawner } from "effect/process";
import * as ServerConfig from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as IdAllocator from "../IdAllocator.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";
import { makeOmpAdapterV2 } from "./OmpAdapterV2.ts";
import { parseOmpResume, selectOmpPermissionOptionId } from "../../provider/acp/OmpAcpSupport.ts";

const layer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "omp-v2-test-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);
const instanceId = ProviderInstanceId.make("omp-v2-test");
const threadId = ThreadId.make("omp-v2-thread");
const settings = Schema.decodeSync(OmpSettings)({});

const makeFixture = Effect.fnUntraced(function* (environment: NodeJS.ProcessEnv = {}) {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "omp-v2-wire-" });
  const logPath = NodePath.join(dir, "wire.jsonl");
  const wrapper = NodePath.join(dir, "omp");
  const fixture = new URL("./OmpAdapterV2.fixture.mjs", import.meta.url).pathname;
  // All shell values are fixture paths; single quotes are escaped, never evaluated.
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  yield* fs.writeFileString(
    wrapper,
    `#!/bin/sh
exec ${quote(process.execPath)} ${quote(fixture)} "$@"
`,
  );
  yield* fs.chmod(wrapper, 0o755);
  const adapter = makeOmpAdapterV2({
    instanceId,
    settings: { ...settings, binaryPath: wrapper, launchArgs: "--profile test --yolo" },
    environment: { OMP_WIRE_LOG: logPath, ...environment },
    childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
    crypto: yield* Crypto.Crypto,
    fileSystem: fs,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    serverConfig: yield* ServerConfig.ServerConfig,
    selfInvocation: yield* resolveSelfInvocation(),
  });
  const readLog = fs.readFileString(logPath).pipe(
    Effect.map((raw) =>
      raw
        .trim()
        .split("\n")
        .map((line): Record<string, unknown> => JSON.parse(line)),
    ),
  );
  return { adapter, readLog, logPath };
});

const open = Effect.fnUntraced(function* (
  environment: NodeJS.ProcessEnv = {},
  runtimeMode: ProviderAdapterV2RuntimePolicy["runtimeMode"] = "full-access",
  modelSelection: ModelSelection = { instanceId, model: "default" },
  initialNativeThreadId?: string,
  policyOverrides: Pick<ProviderAdapterV2RuntimePolicy, "approvalPolicy" | "sandboxPolicy"> = {},
) {
  const fixture = yield* makeFixture(environment);
  const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd: process.cwd(),
    ...policyOverrides,
  });
  const runtime = yield* fixture.adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("omp-v2-session"),
    modelSelection,
    runtimePolicy,
    ...(initialNativeThreadId === undefined ? {} : { initialNativeThreadId }),
  });
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const turnInput = makeTurnInput({
    threadId,
    providerThread,
    instanceId,
    runtimePolicy,
    modelSelection,
    now: yield* DateTime.now,
  });
  return { ...fixture, runtime, runtimePolicy, providerThread, turnInput };
});

function makeTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly instanceId: ProviderInstanceId;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
  readonly now: DateTime.Utc;
  readonly ordinal?: number;
  readonly modelSelection?: ModelSelection;
  /** agent+provider marks a post-settle continuation attach (drains wakeBuffer). */
  readonly messageCreatedBy?: "user" | "agent";
  readonly messageCreationSource?: "web" | "mobile" | "mcp" | "provider" | "server";
  readonly messageText?: string;
}): ProviderAdapterV2TurnInput {
  const ordinal = input.ordinal ?? 1;
  const suffix = `${input.threadId}:${ordinal}`;
  const modelSelection =
    input.modelSelection ?? ({ instanceId: input.instanceId, model: "default" } as const);
  return {
    appThread: {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId: ProjectId.make(`project:${input.threadId}`),
      title: "OMP adapter test",
      providerInstanceId: input.instanceId,
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: input.providerThread.id,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: input.threadId,
      },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    threadId: input.threadId,
    runId: RunId.make(`run:${suffix}`),
    runOrdinal: ordinal,
    providerTurnOrdinal: ordinal,
    attemptId: RunAttemptId.make(`attempt:${suffix}`),
    rootNodeId: NodeId.make(`node:${suffix}`),
    providerThread: input.providerThread,
    message: {
      createdBy: input.messageCreatedBy ?? "user",
      creationSource: input.messageCreationSource ?? "web",
      messageId: MessageId.make(`message:${suffix}`),
      text: input.messageText ?? "test prompt",
      attachments: [],
    },
    modelSelection,
    runtimePolicy: input.runtimePolicy,
  };
}

const params = (entry: Record<string, unknown>) =>
  entry.params as Record<string, unknown> | undefined;
const response = (log: ReadonlyArray<Record<string, unknown>>, id: string) =>
  log.find((entry) => entry.id === id && entry.result !== undefined)?.result;

describe("OMP V2 native ACP parity", () => {
  it.effect("keeps native prompts and launch policy while projecting assistant output", () =>
    Effect.gen(function* () {
      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("omp-test-environment"),
        threadId,
        providerSessionId: "omp-test-mcp",
        providerInstanceId: instanceId,
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer omp-fixture-token",
        browserToolsAvailable: false,
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
      );
      const { runtime, turnInput, readLog } = yield* open();
      yield* runtime.startTurn({
        ...turnInput,
        message: { ...turnInput.message, text: "Please inspect this" },
      });
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
      );
      const terminal = events.find((event) => event.type === "turn.terminal");
      assert.equal(terminal?.type === "turn.terminal" ? terminal.status : undefined, "completed");
      assert.isTrue(
        events.some(
          (event) => event.type === "message.updated" && event.message.text === "hello from OMP",
        ),
      );
      const log = yield* readLog;
      assert.deepEqual(log[0]?.launchArgs, ["acp", "--profile", "test", "--approval-mode", "yolo"]);
      const nativeSetup = log.find((entry) => entry.method === "session/new");
      const mcpServers = params(nativeSetup!)?.mcpServers as ReadonlyArray<{
        name: string;
        command: string;
      }>;
      assert.equal(mcpServers[0]?.name, "t3-code");
      assert.isString(mcpServers[0]?.command);
      const prompt = log.find((entry) => entry.method === "session/prompt");
      assert.deepEqual(params(prompt!)?.prompt, [{ type: "text", text: "Please inspect this" }]);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect(
    "applies model, thinking and native implementation mode and resumes native sessions",
    () =>
      Effect.gen(function* () {
        const { runtime, readLog } = yield* open(
          {},
          "full-access",
          { instanceId, model: "test-model", options: [{ id: "thinking", value: "high" }] },
          "saved-omp-session",
        );
        assert.equal(runtime.providerSession.driver, "omp");
        const log = yield* readLog;
        assert.isTrue(
          log.some(
            (entry) =>
              entry.method === "session/load" && params(entry)?.sessionId === "saved-omp-session",
          ),
        );
        assert.isTrue(
          log.some(
            (entry) =>
              entry.method === "session/set_config_option" &&
              params(entry)?.configId === "model" &&
              params(entry)?.value === "test-model",
          ),
        );
        assert.isTrue(
          log.some(
            (entry) =>
              entry.method === "session/set_config_option" &&
              params(entry)?.configId === "thinking_level" &&
              params(entry)?.value === "high",
          ),
        );
        assert.isTrue(
          log.some(
            (entry) => entry.method === "session/set_mode" && params(entry)?.modeId === "agent",
          ),
        );
        assert.isFalse(runtime.providerSession.capabilities.threads.canRollbackThread);
      }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect.each(["full-access", "auto-accept-edits"] as const)(
    "auto-approves native edit gates in %s",
    (runtimeMode) =>
      Effect.gen(function* () {
        const { runtime, turnInput, readLog } = yield* open(
          { OMP_PERMISSION: "edit" },
          runtimeMode,
        );
        yield* runtime.startTurn(turnInput);
        const events = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        assert.isFalse(events.some((event) => event.type === "runtime_request.updated"));
        assert.deepEqual(response(yield* readLog, "omp-permission"), {
          outcome: { outcome: "selected", optionId: "omp-allow-always" },
        });
      }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("honors explicit sandbox restrictions at launch and permission response", () =>
    Effect.gen(function* () {
      const { runtime, turnInput, readLog } = yield* open(
        { OMP_PERMISSION: "execute" },
        "full-access",
        { instanceId, model: "default" },
        undefined,
        { approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } },
      );
      yield* runtime.startTurn(turnInput);
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
      );
      assert.isFalse(events.some((event) => event.type === "runtime_request.updated"));
      const log = yield* readLog;
      assert.deepEqual(log[0]?.launchArgs, [
        "acp",
        "--profile",
        "test",
        "--approval-mode",
        "always-ask",
      ]);
      assert.deepEqual(response(log, "omp-permission"), {
        outcome: { outcome: "selected", optionId: "omp-reject" },
      });
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect.each(["accept", "acceptForSession", "decline", "cancel"] as const)(
    "sends OMP option IDs for %s",
    (decision) =>
      Effect.gen(function* () {
        const { runtime, turnInput, readLog } = yield* open(
          { OMP_PERMISSION: "execute" },
          "approval-required",
        );
        yield* runtime.startTurn(turnInput);
        const pending = yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
          ),
          Stream.runHead,
        );
        if (pending._tag !== "Some" || pending.value.type !== "runtime_request.updated")
          return yield* Effect.die("Missing approval");
        yield* runtime.respondToRuntimeRequest({
          requestId: pending.value.runtimeRequest.id,
          decision,
        });
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runDrain,
        );
        assert.deepEqual(
          response(yield* readLog, "omp-permission"),
          decision === "cancel"
            ? { outcome: { outcome: "cancelled" } }
            : {
                outcome: {
                  outcome: "selected",
                  optionId:
                    decision === "accept"
                      ? "omp-allow-once"
                      : decision === "acceptForSession"
                        ? "omp-allow-always"
                        : "omp-reject",
                },
              },
        );
      }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("maps native choice, custom, boolean, integer and array forms on the wire", () =>
    Effect.gen(function* () {
      const { runtime, turnInput, readLog } = yield* open({ OMP_ELICITATION: "1" });
      yield* runtime.startTurn(turnInput);
      const initial = yield* runtime.events.pipe(
        Stream.takeUntil(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "user_input_request",
        ),
        Stream.runCollect,
      );
      const pending = initial.find(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      );
      const form = initial.find(
        (event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "user_input_request",
      );
      if (
        pending?.type !== "runtime_request.updated" ||
        form?.type !== "turn_item.updated" ||
        form.turnItem.type !== "user_input_request"
      )
        return yield* Effect.die("Missing form");
      const request = pending.runtimeRequest;
      assert.deepEqual(
        form.turnItem.questions.map((question) => question.id),
        ["target", "confirmed", "count", "regions"],
      );
      assert.deepEqual(
        form.turnItem.questions[0]?.options.map((option) => option.label),
        ["Preview", "Production"],
      );
      assert.deepEqual(
        form.turnItem.questions[0]?.options.map((option) => option.value),
        ["preview", "production"],
      );
      assert.isTrue(form.turnItem.questions[0]?.allowCustomAnswer);
      assert.isTrue(form.turnItem.questions[3]?.multiSelect);
      yield* runtime.respondToRuntimeRequest({
        requestId: request.id,
        answers: { target: "staging", confirmed: "Yes", count: "3", regions: ["eu", "unknown"] },
      });
      yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runDrain,
      );
      assert.deepEqual(response(yield* readLog, "omp-elicitation"), {
        action: {
          action: "accept",
          content: { target__other: "staging", confirmed: true, count: 3, regions: ["eu"] },
        },
      });
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect.each([{ OMP_SILENT: "1" }, { OMP_EXIT_PROMPT: "1" }])(
    "reports native empty output or process death as failed",
    (environment) =>
      Effect.gen(function* () {
        const { runtime, turnInput } = yield* open(environment);
        yield* runtime.startTurn(turnInput);
        const events = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const terminal = events.find((event) => event.type === "turn.terminal");
        assert.equal(terminal?.type === "turn.terminal" ? terminal.status : undefined, "failed");
        if (
          environment.OMP_SILENT === "1" &&
          terminal?.type === "turn.terminal" &&
          terminal.status === "failed"
        )
          assert.include(terminal.failure.message ?? "", "no response content");
      }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect(
    "interrupts a pending native prompt without treating cancellation as an empty response",
    () =>
      Effect.gen(function* () {
        const { runtime, turnInput, readLog } = yield* open({ OMP_HANG_PROMPT: "1" });
        yield* runtime.startTurn(turnInput);
        const waiting = yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
          ),
          Stream.runHead,
        );
        if (
          waiting._tag !== "Some" ||
          waiting.value.type !== "turn_item.updated" ||
          waiting.value.turnItem.providerTurnId === null
        )
          return yield* Effect.die("Missing command receipt");
        yield* runtime.interruptTurn({
          providerThread: turnInput.providerThread,
          providerTurnId: waiting.value.turnItem.providerTurnId,
        });
        const events = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const terminal = events.find((event) => event.type === "turn.terminal");
        assert.equal(
          terminal?.type === "turn.terminal" ? terminal.status : undefined,
          "interrupted",
        );
        assert.isTrue((yield* readLog).some((entry) => entry.method === "session/cancel"));
      }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("closes the captured native child when its V2 session scope closes", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const sessionScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(sessionScope, Exit.void));
      yield* fixture.adapter
        .openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("omp-close-session"),
          modelSelection: { instanceId, model: "default" },
          runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
          }),
        })
        .pipe(Effect.provideService(Scope.Scope, sessionScope));
      const pid = (yield* fixture.readLog)[0]?.pid;
      assert.isNumber(pid);
      yield* Scope.close(sessionScope, Exit.void);
      assert.throws(() => process.kill(pid as number, 0), /ESRCH/);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("surfaces model configuration failures", () =>
    Effect.gen(function* () {
      const result = yield* open({ OMP_FAIL_MODEL: "1" }, "full-access", {
        instanceId,
        model: "test-model",
      }).pipe(Effect.result);
      assert.isTrue(Result.isFailure(result));
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it("refuses unsupported or malformed legacy resume cursors", () => {
    assert.deepEqual(parseOmpResume({ schemaVersion: 1, sessionId: " saved " }), {
      sessionId: "saved",
    });
    assert.isUndefined(parseOmpResume({ schemaVersion: 2, sessionId: "saved" }));
    assert.isUndefined(parseOmpResume({ schemaVersion: 1, sessionId: " " }));
  });

  it("falls back to native permission options when only the other allow/reject kind exists", () => {
    const request = {
      sessionId: "omp",
      toolCall: { toolCallId: "tool" },
      options: [
        { optionId: "always", name: "Allow", kind: "allow_always" as const },
        { optionId: "reject-always", name: "Reject", kind: "reject_always" as const },
      ],
    };
    assert.equal(selectOmpPermissionOptionId(request, "accept"), "always");
    assert.equal(selectOmpPermissionOptionId(request, "decline"), "reject-always");
  });
});

const migrationStores = Layer.mergeAll(
  SqlitePersistence.layerMemory,
  EventStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
);
const migrationSink = EventSink.layer.pipe(Layer.provide(migrationStores));
const migrationLayer = Layer.mergeAll(
  layer,
  migrationStores,
  migrationSink,
  LegacyImporter.layer.pipe(Layer.provide(Layer.mergeAll(migrationStores, migrationSink))),
);

const encodeLegacyModel = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ instanceId: ProviderInstanceId, model: Schema.String })),
);

const seedLegacyOmp = Effect.fnUntraced(function* (
  suffix: string,
  binding: { provider?: string; instance?: string | null; adapter?: string; cursor?: string } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const legacyThreadId = ThreadId.make(`omp-legacy-${suffix}`);
  const model = yield* encodeLegacyModel({ instanceId, model: "default" });
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at)
    VALUES ('omp-project', 'OMP project', '/tmp/project', ${model}, '[]', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z') ON CONFLICT DO NOTHING`;
  yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
    VALUES (${legacyThreadId}, 'omp-project', 'Existing OMP thread', ${model}, 'full-access', 'default', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`;
  yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
    VALUES (${`message-${suffix}`}, ${legacyThreadId}, 'assistant', 'Existing OMP history', 0, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`;
  yield* sql`INSERT INTO provider_session_runtime (thread_id, provider_name, provider_instance_id, adapter_key, runtime_mode, status, last_seen_at, resume_cursor_json, runtime_payload_json)
    VALUES (${legacyThreadId}, ${binding.provider ?? "omp"}, ${binding.instance === undefined ? instanceId : binding.instance}, ${binding.adapter ?? "omp"}, 'full-access', 'stopped', '2026-10-01T00:00:00.000Z', ${binding.cursor ?? '{"schemaVersion":1,"sessionId":"saved-omp-session"}'}, '{"cwd":"/tmp/project"}')`;
  return legacyThreadId;
});

describe("OMP V1 to V2 cutover", () => {
  it.effect(
    "retains native identity without opening a process or sending imported history until the next user turn",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const fixture = yield* makeFixture();
        const legacyThreadId = yield* seedLegacyOmp("valid");
        const importer = yield* LegacyImporter.LegacyV1ThreadImporter;
        yield* importer.reconcileShells;
        yield* importer.ensureTranscript(legacyThreadId);
        assert.isFalse(yield* fs.exists(fixture.logPath));
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const projection = yield* projections.getThreadProjection(legacyThreadId);
        assert.equal(projection.thread.historyOrigin, "v1_import");
        assert.equal(projection.messages[0]?.text, "Existing OMP history");
        const nativeThread = projection.providerThreads[0];
        assert.isDefined(nativeThread);
        assert.equal(nativeThread!.nativeThreadRef?.nativeId, "saved-omp-session");
        assert.equal(nativeThread!.providerInstanceId, instanceId);
        assert.equal(nativeThread!.providerSessionId, null);
        assert.equal(nativeThread!.status, "not_loaded");
        assert.equal(projection.thread.activeProviderThreadId, nativeThread!.id);
        assert.isFalse(
          shouldPrepareLegacyImportHandoff({
            historyOrigin: projection.thread.historyOrigin,
            hasCompletedRun: false,
            legacyImportItemCount: projection.turnItems.length,
            hasRetainedNativeHistory: true,
          }),
        );
        assert.deepEqual(yield* importer.reconcileShells, {
          importedThreadCount: 0,
          importedMessageCount: 0,
        });
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const nativeId = nativeThread?.nativeThreadRef?.nativeId;
        if (nativeId == null) return yield* Effect.die("Missing retained native session");
        const runtime = yield* fixture.adapter.openSession({
          threadId: legacyThreadId,
          providerSessionId: ProviderSessionId.make("omp-migrated-runtime"),
          modelSelection: projection.thread.modelSelection,
          runtimePolicy,
          initialNativeThreadId: nativeId,
        });
        yield* runtime.resumeThread({
          providerThread: nativeThread!,
          threadId: legacyThreadId,
          modelSelection: projection.thread.modelSelection,
          runtimePolicy,
        });
        assert.isFalse((yield* fixture.readLog).some((entry) => entry.method === "session/prompt"));
        const turnInput = makeTurnInput({
          threadId: legacyThreadId,
          providerThread: nativeThread!,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
          messageText: "Continue this work",
        });
        yield* runtime.startTurn({ ...turnInput, appThread: projection.thread });
        const events = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        assert.isTrue(
          events.some((event) => event.type === "turn.terminal" && event.status === "completed"),
        );
        const prompts = (yield* fixture.readLog).filter(
          (entry) => entry.method === "session/prompt",
        );
        assert.lengthOf(prompts, 1);
        assert.deepEqual(params(prompts[0]!)?.prompt, [
          { type: "text", text: "Continue this work" },
        ]);
      }).pipe(Effect.provide(migrationLayer), Effect.scoped),
  );

  it.effect(
    "falls back to upstream imported-history handling for malformed or incompatible native bindings",
    () =>
      Effect.gen(function* () {
        const cases = [
          { provider: "codex" },
          { instance: "other-omp-instance" },
          { instance: null },
          { adapter: "other-adapter" },
          { cursor: '{"schemaVersion":2,"sessionId":"saved"}' },
          { cursor: '{"schemaVersion":1,"sessionId":" "}' },
          { cursor: "invalid JSON" },
        ];
        const importer = yield* LegacyImporter.LegacyV1ThreadImporter;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        for (const [index, binding] of cases.entries()) {
          const legacyThreadId = yield* seedLegacyOmp(`invalid-${index}`, binding);
          yield* importer.reconcileShells;
          const projection = yield* projections.getThreadProjection(legacyThreadId);
          assert.lengthOf(projection.providerThreads, 0);
          assert.isNull(projection.thread.activeProviderThreadId);
          assert.isTrue(
            shouldPrepareLegacyImportHandoff({
              historyOrigin: projection.thread.historyOrigin,
              hasCompletedRun: false,
              legacyImportItemCount: projection.turnItems.length,
            }),
          );
        }
      }).pipe(Effect.provide(migrationLayer), Effect.scoped),
  );
});
