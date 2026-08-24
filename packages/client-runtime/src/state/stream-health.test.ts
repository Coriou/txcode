import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { EMPTY_SHELL_STATE, shellStreamIsLive } from "./shell.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  environmentThreadStreamHealth,
  type EnvironmentThreadState,
} from "./threadState.ts";

const threadState = (overrides: Partial<EnvironmentThreadState>): EnvironmentThreadState => ({
  ...EMPTY_ENVIRONMENT_THREAD_STATE,
  ...overrides,
});

describe("environmentThreadStreamHealth", () => {
  it("reports live only for the live status", () => {
    expect(environmentThreadStreamHealth(threadState({ status: "live" }))).toBe("live");
  });

  it("reports connecting for tracked-but-unerrored states that are not yet live", () => {
    expect(environmentThreadStreamHealth(threadState({ status: "synchronizing" }))).toBe(
      "connecting",
    );
    expect(environmentThreadStreamHealth(EMPTY_ENVIRONMENT_THREAD_STATE)).toBe("connecting");
    // Opening a working thread from cache is the common pre-attach state.
    expect(environmentThreadStreamHealth(threadState({ status: "cached" }))).toBe("connecting");
  });

  it("reports detached whenever an error is tracked and the stream is not live", () => {
    expect(
      environmentThreadStreamHealth(threadState({ status: "cached", error: Option.some("boom") })),
    ).toBe("detached");
    expect(
      environmentThreadStreamHealth(
        threadState({ status: "synchronizing", error: Option.some("boom") }),
      ),
    ).toBe("detached");
    expect(
      environmentThreadStreamHealth(threadState({ status: "empty", error: Option.some("boom") })),
    ).toBe("detached");
    // Error precedence over live pins the branch order.
    expect(
      environmentThreadStreamHealth(threadState({ status: "live", error: Option.some("boom") })),
    ).toBe("detached");
  });

  it("reports deleted regardless of error state", () => {
    expect(environmentThreadStreamHealth(threadState({ status: "deleted" }))).toBe("deleted");
  });
});

describe("shellStreamIsLive", () => {
  it("is live only for the live status", () => {
    expect(shellStreamIsLive({ ...EMPTY_SHELL_STATE, status: "live" })).toBe(true);
    expect(shellStreamIsLive(EMPTY_SHELL_STATE)).toBe(false);
    expect(shellStreamIsLive({ ...EMPTY_SHELL_STATE, status: "synchronizing" })).toBe(false);
    expect(shellStreamIsLive({ ...EMPTY_SHELL_STATE, status: "cached" })).toBe(false);
  });
});
