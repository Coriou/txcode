import {
  OrchestrationDispatchCommandError,
  OrchestrationV2GetThreadProjectionError,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  wasBootstrapThreadDeleted,
  wasBootstrapThreadNotCreated,
  wasSubscribeThreadNotFound,
} from "./orchestration.ts";

describe("wasSubscribeThreadNotFound", () => {
  it("recognizes a confirmed miss after the error crosses the wire", () => {
    const codec = Schema.fromJsonString(OrchestrationV2GetThreadProjectionError);
    const error = new OrchestrationV2GetThreadProjectionError({
      threadId: ThreadId.make("thread-1"),
      message: "Failed to load orchestration V2 thread thread-1",
      reason: "not-found",
    });
    expect(
      wasSubscribeThreadNotFound(Schema.decodeSync(codec)(Schema.encodeSync(codec)(error))),
    ).toBe(true);
  });

  it("does not infer deletion from message text, legacy errors, or untyped values", () => {
    expect(
      wasSubscribeThreadNotFound(
        new OrchestrationV2GetThreadProjectionError({
          threadId: ThreadId.make("thread-1"),
          message: "Thread thread-1 was not found",
        }),
      ),
    ).toBe(false);
    expect(wasSubscribeThreadNotFound({ reason: "not-found" })).toBe(false);
    expect(wasSubscribeThreadNotFound(new Error("Thread thread-1 was not found"))).toBe(false);
    expect(wasSubscribeThreadNotFound(null)).toBe(false);
  });
});

describe("wasBootstrapThreadDeleted", () => {
  it("accepts only a confirmed deleted bootstrap thread", () => {
    expect(
      wasBootstrapThreadDeleted(
        new OrchestrationDispatchCommandError({
          message: "Failed to create worktree.",
          bootstrapThreadDisposition: "deleted",
        }),
      ),
    ).toBe(true);
  });

  it("rejects a missing disposition", () => {
    expect(
      wasBootstrapThreadDeleted(
        new OrchestrationDispatchCommandError({ message: "Failed to create worktree." }),
      ),
    ).toBe(false);
  });

  it("rejects unrelated errors", () => {
    expect(wasBootstrapThreadDeleted(new Error("connection lost"))).toBe(false);
  });
});

describe("wasBootstrapThreadNotCreated", () => {
  it("accepts only a confirmed never-created bootstrap thread", () => {
    const notCreated = new OrchestrationDispatchCommandError({
      message: "A separate worktree requires a base commit.",
      bootstrapThreadDisposition: "not-created",
    });
    expect(wasBootstrapThreadNotCreated(notCreated)).toBe(true);
    expect(wasBootstrapThreadDeleted(notCreated)).toBe(false);
    expect(
      wasBootstrapThreadNotCreated(
        new OrchestrationDispatchCommandError({
          message: "Failed to create worktree.",
          bootstrapThreadDisposition: "deleted",
        }),
      ),
    ).toBe(false);
    expect(
      wasBootstrapThreadNotCreated(
        new OrchestrationDispatchCommandError({
          message: "Failed to create worktree.",
        }),
      ),
    ).toBe(false);
    expect(wasBootstrapThreadNotCreated(new Error("connection lost"))).toBe(false);
  });
});
