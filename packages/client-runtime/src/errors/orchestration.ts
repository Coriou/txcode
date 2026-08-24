import {
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

export function wasBootstrapThreadDeleted(error: unknown): boolean {
  return (
    isOrchestrationDispatchCommandError(error) && error.bootstrapThreadDisposition === "deleted"
  );
}

const isOrchestrationGetSnapshotError = Schema.is(OrchestrationGetSnapshotError);

/** Server wording for a subscribeThread miss (`apps/server/src/ws.ts`: `Thread ${threadId} was not found`). */
const THREAD_NOT_FOUND_MESSAGE = /^Thread .+ was not found$/;

export function wasSubscribeThreadNotFound(error: unknown): boolean {
  return isOrchestrationGetSnapshotError(error) && THREAD_NOT_FOUND_MESSAGE.test(error.message);
}
