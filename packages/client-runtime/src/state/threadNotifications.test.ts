import { DEFAULT_CLIENT_SETTINGS, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { shouldDeliverThreadNotification } from "./threadNotifications.ts";
const base = {
  kind: "approval-requested" as const,
  environmentId: EnvironmentId.make("env-a"),
  threadId: ThreadId.make("thread"),
  settings: DEFAULT_CLIENT_SETTINGS,
  focused: true,
  activeEnvironmentId: "env-a",
  activeThreadId: "thread",
};
describe("V2 system-notification policy", () => {
  it("respects selective opt-outs in every focus state", () => {
    expect(
      shouldDeliverThreadNotification({
        ...base,
        focused: false,
        settings: { ...base.settings, notifyOnApprovalRequested: false },
      }),
    ).toBe(false);
  });
  it("compares the environment as well as thread ID", () => {
    expect(shouldDeliverThreadNotification(base)).toBe(false);
    expect(shouldDeliverThreadNotification({ ...base, activeEnvironmentId: "env-b" })).toBe(true);
  });
  it("preserves Always and unfocused-only semantics", () => {
    expect(
      shouldDeliverThreadNotification({
        ...base,
        settings: { ...base.settings, notificationFocusRule: "always" },
      }),
    ).toBe(true);
    expect(
      shouldDeliverThreadNotification({
        ...base,
        activeThreadId: "other",
        settings: { ...base.settings, notificationFocusRule: "unfocused" },
      }),
    ).toBe(false);
    expect(shouldDeliverThreadNotification({ ...base, focused: false })).toBe(true);
  });
});

it("keeps background upstream alerts without broadening legacy foreground alerts", () => {
  const mixed = {
    ...base,
    kind: "turn-completed" as const,
    settings: {
      ...DEFAULT_CLIENT_SETTINGS,
      notificationFocusRule: "always" as const,
      notificationForegroundKinds: ["approval-requested" as const],
    },
  };
  expect(shouldDeliverThreadNotification(mixed)).toBe(false);
  expect(shouldDeliverThreadNotification({ ...mixed, focused: false })).toBe(true);
  expect(shouldDeliverThreadNotification({ ...mixed, kind: "approval-requested" })).toBe(true);
});
