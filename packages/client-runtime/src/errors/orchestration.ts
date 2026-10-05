import {
  OrchestrationDispatchCommandError,
  OrchestrationV2GetThreadProjectionError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

export function wasBootstrapThreadDeleted(error: unknown): boolean {
  return (
    isOrchestrationDispatchCommandError(error) && error.bootstrapThreadDisposition === "deleted"
  );
}

export function wasBootstrapThreadNotCreated(error: unknown): boolean {
  return (
    isOrchestrationDispatchCommandError(error) && error.bootstrapThreadDisposition === "not-created"
  );
}

const isOrchestrationV2GetThreadProjectionError = Schema.is(
  OrchestrationV2GetThreadProjectionError,
);

/** Fork: only a server-confirmed projection miss terminates a thread subscription. */
export function wasSubscribeThreadNotFound(error: unknown): boolean {
  return isOrchestrationV2GetThreadProjectionError(error) && error.reason === "not-found";
}
