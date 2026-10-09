import { assert, it } from "@effect/vitest";
import { OrchestrationV2GetThreadProjectionError, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as OrchestrationEventStore from "./persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import { OrchestratorProjectionError } from "./orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "./orchestration-v2/ThreadManagementService.ts";
import { subscribeOrchestrationV2Thread } from "./ws.ts";

const codec = Schema.fromJsonString(OrchestrationV2GetThreadProjectionError);
const encodeProjectionError = Schema.encodeEffect(codec);
const decodeProjectionError = Schema.decodeEffect(codec);

// Exercise the real projection lookup and transport mapping without opening a socket.
const services = Layer.unwrap(
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return Layer.mock(ThreadManagementService.ThreadManagementService)({
      ensureLegacyTranscript: () => Effect.void,
      getThreadSnapshot: (threadId) =>
        projections
          .getThreadSnapshot(threadId)
          .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause }))),
      getThreadSnapshotWindow: (threadId, options) =>
        projections
          .getThreadSnapshotWindow(threadId, options)
          .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause }))),
    });
  }),
).pipe(
  Layer.provide(ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
  Layer.merge(Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({})),
);

it.effect.each([false, true])(
  "serializes a definitive missing thread reason (bounded=%s)",
  (bounded) =>
    Effect.gen(function* () {
      const error = yield* subscribeOrchestrationV2Thread({
        threadId: ThreadId.make("missing-thread"),
        acceptBoundedSnapshot: bounded,
      }).pipe(Effect.flip);
      const decoded = yield* decodeProjectionError(yield* encodeProjectionError(error));
      assert.equal(decoded.reason, "not-found");
      assert.equal(decoded.threadId, "missing-thread");
    }).pipe(Effect.provide(services)),
);

it.effect("does not mark a transient projection failure as a missing thread", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread");
    const error = yield* subscribeOrchestrationV2Thread({ threadId }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            ensureLegacyTranscript: () => Effect.void,
            getThreadSnapshot: () =>
              Effect.fail(
                new OrchestratorProjectionError({
                  threadId,
                  cause: new Error("database unavailable"),
                }),
              ),
          }),
          Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
        ),
      ),
      Effect.flip,
    );
    assert.isUndefined(error.reason);
  }),
);
