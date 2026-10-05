import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { EMPTY_THREAD_HISTORY_META, type ThreadHistoryMeta } from "./threadHistoryMerge.ts";

export type EnvironmentThreadStatus = "empty" | "cached" | "synchronizing" | "live" | "deleted";

export interface EnvironmentThreadState {
  readonly data: Option.Option<OrchestrationV2ThreadProjection>;
  readonly status: EnvironmentThreadStatus;
  readonly error: Option.Option<string>;
  /**
   * Progressive history cursor for bounded hydration. Absent/cleared on full
   * snapshot paths. Errors here are thread/history-local and must not be
   * promoted into the environment disconnect path.
   */
  readonly history: ThreadHistoryMeta;
}

export const EMPTY_ENVIRONMENT_THREAD_STATE: EnvironmentThreadState = {
  data: Option.none(),
  status: "empty",
  error: Option.none(),
  history: EMPTY_THREAD_HISTORY_META,
};

export type EnvironmentThreadStreamHealth = "live" | "connecting" | "detached" | "deleted";

/**
 * Whether turn activity may render as healthy live work: "Working" may only
 * render while the detail stream that would deliver the turn completion is
 * alive. Pure and dependency-free so the web and mobile clients can share it.
 */
export function environmentThreadStreamHealth(
  state: EnvironmentThreadState,
): EnvironmentThreadStreamHealth {
  if (state.status === "deleted") return "deleted";
  if (Option.isSome(state.error)) return "detached";
  if (state.status === "live") return "live";
  return "connecting";
}
