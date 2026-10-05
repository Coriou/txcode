import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  mode: "off" as ClientSettings["notificationMode"],
  preferences: null as Partial<ClientSettings> | null,
  inApp: true,
  active: { environmentId: "env-1", threadId: "other-thread" },
  focused: true,
  visible: "visible",
  live: true,
  completedAt: null as string | null,
  archivedAt: null as string | null,
  input: false,
  approval: false,
  sessionError: false,
  turnError: false,
  limited: false,
  subagent: false,
  background: [] as Array<{ taskId: string; kind: "command" | "monitor" }>,
  add: vi.fn(
    (_toast: { title: string; description: string; actionProps: { onClick: () => void } }) =>
      "toast-1",
  ),
  close: vi.fn(),
  navigate: vi.fn(),
  sound: vi.fn(),
  badge: vi.fn(),
  notification: vi.fn(function (_title: string, options: NotificationOptions) {
    return Object.assign(new EventTarget(), { tag: options.tag, close: vi.fn() });
  }),
}));

const SHELL_NOW = DateTime.makeUnsafe("2026-09-13T09:00:00.000Z");

function mockThreadShell() {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Fix the login form",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: "thread-1",
      parentThreadId: state.subagent ? "parent" : null,
      relationshipToParent: state.subagent ? "subagent" : null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: "run-1",
    activeRunId: null,
    status: state.completedAt
      ? "completed"
      : state.sessionError || state.turnError || state.limited
        ? "failed"
        : "running",
    lastErrorClass: state.limited ? "usage_limit" : null,
    pendingRuntimeRequest: state.input
      ? { id: "request-1", kind: "user_input", createdAt: SHELL_NOW }
      : state.approval
        ? { id: "request-1", kind: "command", createdAt: SHELL_NOW }
        : null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: state.background,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: SHELL_NOW,
    updatedAt: SHELL_NOW,
    latestRunRequestedAt: SHELL_NOW,
    latestRunStartedAt: SHELL_NOW,
    latestRunCompletedAt: state.completedAt ? DateTime.makeUnsafe(state.completedAt) : undefined,
    archivedAt: state.archivedAt ? DateTime.makeUnsafe(state.archivedAt) : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({
    status: state.live ? "live" : "disconnected",
    snapshot: Option.some({ threads: [mockThreadShell()] }),
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useParams: () => state.active,
}));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (
    select: (
      settings: Pick<ClientSettings, "notificationMode" | "inAppNotificationsEnabled">,
    ) => unknown,
  ) => select({ notificationMode: state.mode, inAppNotificationsEnabled: state.inApp }),
  getClientSettings: () => ({
    ...DEFAULT_CLIENT_SETTINGS,
    notificationFocusRule: "unfocused",
    ...state.preferences,
    notificationMode: state.mode,
    inAppNotificationsEnabled: state.inApp,
  }),
}));
vi.mock("../state/environments", () => ({
  useEnvironmentIds: () => ["env-1"],
}));
vi.mock("../state/shell", () => ({
  environmentShell: { stateValueAtom: vi.fn() },
}));
vi.mock("../threadNotifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../threadNotifications")>()),
  playNotificationSound: state.sound,
  setNotificationBadge: state.badge,
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: state.add, close: state.close },
}));

import { ThreadNotificationCoordinator } from "./ThreadNotificationCoordinator";

let renderer: ReactTestRenderer | undefined;

async function render() {
  await act(() => {
    if (renderer) renderer.update(<ThreadNotificationCoordinator />);
    else renderer = create(<ThreadNotificationCoordinator />);
  });
}

async function complete() {
  state.completedAt = "2026-09-13T10:00:00.000Z";
  await render();
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, {
    mode: "off",
    preferences: null,
    inApp: true,
    active: { environmentId: "env-1", threadId: "other-thread" },
    focused: true,
    visible: "visible",
    live: true,
    completedAt: null,
    archivedAt: null,
    input: false,
    approval: false,
    sessionError: false,
    turnError: false,
    limited: false,
    subagent: false,
    background: [],
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", {
    get visibilityState() {
      return state.visible;
    },
    hasFocus: () => state.focused,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("Notification", Object.assign(state.notification, { permission: "granted" }));
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("thread notifications", () => {
  it.each([true, false])("keeps subagents silent with focus=%s", async (focused) => {
    state.subagent = true;
    state.focused = focused;
    state.mode = "notifications-and-sound";
    await render();
    await complete();
    state.input = true;
    await render();
    expect(state.sound).not.toHaveBeenCalled();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).not.toHaveBeenCalled();
  });

  it("alerts once with system alerts off and opens the completed thread", async () => {
    await render();
    await complete();
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    const toast = state.add.mock.calls[0]?.[0];
    expect(toast?.title).toBe("Thread completed");
    expect(toast?.description).toBe("Fix the login form");
    toast?.actionProps.onClick();
    expect(state.close).toHaveBeenCalledWith("toast-1");
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env-1", threadId: "thread-1" },
    });
    expect(state.notification).not.toHaveBeenCalled();
  });

  it.each(["active", "blurred", "hidden", "archived", "disabled"])(
    "does not show a completion toast for %s threads",
    async (condition) => {
      await render();
      if (condition === "active") state.active.threadId = "thread-1";
      if (condition === "blurred") state.focused = false;
      if (condition === "hidden") state.visible = "hidden";
      if (condition === "archived") state.archivedAt = "2026-09-13T09:00:00.000Z";
      if (condition === "disabled") state.inApp = false;
      await complete();
      expect(state.add).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["input", "Input needed"],
    ["approval", "Approval needed"],
    ["sessionError", "Thread failed"],
    ["turnError", "Thread failed"],
    ["limited", "Usage limit reached"],
  ] as const)("uses the same %s event for in-app and desktop alerts", async (event, title) => {
    state.mode = "notifications-and-sound";
    await render();
    state[event] = true;
    await render();
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add).toHaveBeenLastCalledWith(expect.objectContaining({ title }));
    expect(state.sound).toHaveBeenCalledWith("input", expect.any(Function));
    expect(state.notification).not.toHaveBeenCalled();

    state[event] = false;
    await render();
    state.focused = false;
    state[event] = true;
    await render();
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.notification).toHaveBeenCalledTimes(1);
    expect(state.notification).toHaveBeenCalledWith(title, {
      body: "Fix the login form",
      tag: "env-1:thread-1",
      silent: true,
    });
  });

  it("alerts when only a dev server is left running, not while a monitor can wake the agent", async () => {
    await render();
    state.background = [{ taskId: "watch", kind: "monitor" }];
    await complete();
    expect(state.add).not.toHaveBeenCalled();
    state.background = [{ taskId: "dev", kind: "command" }];
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Thread completed" }),
    );
  });

  it("keeps background desktop alerts when in-app notifications are disabled", async () => {
    state.focused = false;
    state.inApp = false;
    state.mode = "notifications";
    await render();
    await complete();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).toHaveBeenCalledTimes(1);
    state.inApp = true;
    await render();
    expect(state.add).not.toHaveBeenCalled();
  });

  it("does not replay a completion when opting in from all alerts off", async () => {
    state.inApp = false;
    await render();
    await complete();
    state.inApp = true;
    await render();
    expect(state.add).not.toHaveBeenCalled();
  });

  it("compares the environment as well as the thread", async () => {
    state.active = { environmentId: "env-2", threadId: "thread-1" };
    await render();
    await complete();
    expect(state.add).toHaveBeenCalledTimes(1);
  });

  it("does not replay completed threads on first load or reconnect", async () => {
    await complete();
    state.live = false;
    await render();
    state.live = true;
    await render();
    expect(state.add).not.toHaveBeenCalled();
  });

  it("keeps sound but replaces the system popup when showing a toast", async () => {
    state.mode = "notifications-and-sound";
    await render();
    await complete();
    expect(state.sound).toHaveBeenCalledWith("completion", expect.any(Function));
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.notification).not.toHaveBeenCalled();
  });

  it("keeps system alerts when the app is in the background", async () => {
    state.mode = "notifications";
    state.focused = false;
    await render();
    await complete();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).toHaveBeenCalledWith("Thread completed", {
      body: "Fix the login form",
      tag: "env-1:thread-1",
      silent: true,
    });
  });
});

describe("fork system-delivery parity on V2 events", () => {
  it("delivers one native alert and routes its scoped activation without browser permission", async () => {
    state.mode = "notifications";
    state.focused = false;
    let activate: ((ref: { environmentId: string; threadId: string }) => void) | undefined;
    const show = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const unsubscribe = vi.fn();
    Object.assign(window, {
      desktopBridge: {
        showThreadNotification: show,
        closeThreadNotification: close,
        onThreadNotificationActivate: (listener: typeof activate) => {
          activate = listener;
          return unsubscribe;
        },
      },
    });
    vi.stubGlobal("Notification", undefined);
    await render();
    await complete();
    await render();
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith({
      title: "Thread completed",
      body: "Fix the login form",
      tag: "env-1:thread-1",
      threadRef: { environmentId: "env-1", threadId: "thread-1" },
    });
    await act(() => {
      activate?.({ environmentId: "env-2", threadId: "thread-1" });
    });
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env-2", threadId: "thread-1" },
    });
    state.mode = "off";
    await render();
    expect(close).toHaveBeenCalledWith("env-1:thread-1");
    await act(() => renderer?.unmount());
    renderer = undefined;
    expect(unsubscribe).toHaveBeenCalled();
    expect(state.notification).not.toHaveBeenCalled();
  });

  it("classifies usage-limit attention as failure rather than an input request", async () => {
    state.mode = "notifications";
    state.focused = false;
    state.preferences = { notifyOnFailure: false, notifyOnUserInputRequested: true };
    await render();
    state.limited = true;
    await render();
    expect(state.notification).not.toHaveBeenCalled();
    state.limited = false;
    await render();
    state.preferences = { notifyOnFailure: true, notifyOnUserInputRequested: false };
    state.limited = true;
    await render();
    expect(state.notification).toHaveBeenCalledTimes(1);
  });

  it("keeps Always system delivery while a foreground thread is active", async () => {
    state.mode = "notifications";
    state.preferences = { notificationFocusRule: "always" };
    state.active = { environmentId: "env-1", threadId: "thread-1" };
    await render();
    await complete();
    expect(state.notification).toHaveBeenCalledTimes(1);
    expect(state.add).not.toHaveBeenCalled();
  });
});

function nativeFixture(delay: "none" | "delivery" | "acknowledgement" = "none") {
  const active = new Map<string, number>();
  const replies: Array<() => void> = [];
  let count = 0;
  const show = vi.fn(({ tag = "" }: { readonly tag?: string }) => {
    const id = ++count;
    if (delay !== "delivery") active.set(tag, id);
    if (delay === "none") return Promise.resolve();
    return new Promise<void>((resolve) => {
      replies.push(() => {
        if (delay === "delivery") active.set(tag, id);
        resolve();
      });
    });
  });
  const close = vi.fn((tag: string) => {
    active.delete(tag);
    return Promise.resolve();
  });
  Object.assign(window, {
    desktopBridge: { showThreadNotification: show, closeThreadNotification: close },
  });
  return { active, replies, show, close };
}

describe("native delivery lifecycle", () => {
  it("keeps the new same-tag native alert after repeated completion", async () => {
    state.mode = "notifications";
    state.focused = false;
    const native = nativeFixture();
    await render();
    await complete();
    state.completedAt = "2026-09-13T11:00:00.000Z";
    await render();
    expect(native.show).toHaveBeenCalledTimes(2);
    expect(native.active.get("env-1:thread-1")).toBe(2);
    expect(state.badge).toHaveBeenLastCalledWith(1);
    expect(state.notification).not.toHaveBeenCalled();
  });

  it("never closes a replacement when an older show acknowledgement arrives late", async () => {
    state.mode = "notifications";
    state.focused = false;
    const native = nativeFixture("acknowledgement");
    await render();
    await complete();
    state.completedAt = "2026-09-13T11:00:00.000Z";
    await render();
    const closesBeforeReply = native.close.mock.calls.length;
    await act(() => native.replies[0]!());
    expect(native.close).toHaveBeenCalledTimes(closesBeforeReply);
    expect(native.active.get("env-1:thread-1")).toBe(2);
    await act(() => native.replies[1]!());
    expect(native.active.get("env-1:thread-1")).toBe(2);
  });

  it.each(["focus", "off", "unmount"] as const)(
    "closes late native delivery after %s cleanup instead of restoring its badge",
    async (cleanup) => {
      state.mode = "notifications";
      state.focused = false;
      const native = nativeFixture("delivery");
      await render();
      await complete();
      expect(state.badge).toHaveBeenLastCalledWith(1);
      if (cleanup === "focus") {
        state.focused = true;
        await act(() => {
          window.dispatchEvent(new Event("focus"));
        });
      } else if (cleanup === "off") {
        state.mode = "off";
        await render();
      } else {
        await act(() => renderer?.unmount());
        renderer = undefined;
      }
      expect(state.badge).toHaveBeenLastCalledWith(0);
      await act(() => native.replies[0]!());
      expect(native.active.size).toBe(0);
      expect(state.badge).toHaveBeenLastCalledWith(0);
    },
  );

  it("removes a failed native show from badge tracking", async () => {
    state.mode = "notifications";
    state.focused = false;
    Object.assign(window, {
      desktopBridge: {
        showThreadNotification: vi.fn(() => Promise.reject(new Error("native unavailable"))),
        closeThreadNotification: vi.fn(() => Promise.resolve()),
      },
    });
    await render();
    await complete();
    expect(state.badge).toHaveBeenLastCalledWith(0);
  });
});

describe("system delivery availability", () => {
  it("falls back when a granted browser notification rejects presentation", async () => {
    state.mode = "notifications";
    state.preferences = { notificationFocusRule: "always" };
    vi.stubGlobal(
      "Notification",
      Object.assign(
        function () {
          throw new Error("browser rejected presentation");
        },
        { permission: "granted" },
      ),
    );
    await render();
    await complete();
    expect(state.add).toHaveBeenCalledOnce();
    expect(state.badge).toHaveBeenLastCalledWith(0);
  });

  it("ignores an older failed native delivery after a same-tag replacement", async () => {
    state.mode = "notifications";
    state.preferences = { notificationFocusRule: "always" };
    const replies: Array<(delivered: boolean) => void> = [];
    const close = vi.fn(() => Promise.resolve());
    Object.assign(window, {
      desktopBridge: {
        showThreadNotification: vi.fn(
          () =>
            new Promise<boolean>((resolve) => {
              replies.push(resolve);
            }),
        ),
        closeThreadNotification: close,
      },
    });
    await render();
    await complete();
    state.completedAt = "2026-09-13T11:00:00.000Z";
    await render();
    expect(close).toHaveBeenCalledOnce();
    await act(() => replies[0]!(false));
    expect(close).toHaveBeenCalledOnce();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.badge).toHaveBeenLastCalledWith(1);
    await act(() => replies[1]!(true));
    expect(state.badge).toHaveBeenLastCalledWith(1);
  });

  it.each([false, "reject", true, undefined] as const)(
    "falls back only when native delivery fails (%s), accepting legacy void success",
    async (result) => {
      state.mode = "notifications";
      state.preferences = { notificationFocusRule: "always" };
      const close = vi.fn(() => Promise.resolve());
      Object.assign(window, {
        desktopBridge: {
          showThreadNotification: vi.fn(() =>
            result === "reject"
              ? Promise.reject(new Error("native unavailable"))
              : Promise.resolve(result),
          ),
          closeThreadNotification: close,
        },
      });
      await render();
      await complete();
      const failed = result === false || result === "reject";
      expect(state.badge).toHaveBeenLastCalledWith(failed ? 0 : 1);
      expect(state.add).toHaveBeenCalledTimes(failed ? 1 : 0);
      expect(close).toHaveBeenCalledTimes(failed ? 1 : 0);
      expect(state.notification).not.toHaveBeenCalled();
      if (failed) {
        const toast = state.add.mock.calls[0]?.[0];
        expect(toast?.title).toBe("Thread completed");
        toast?.actionProps.onClick();
        expect(state.navigate).toHaveBeenCalledWith({
          to: "/$environmentId/$threadId",
          params: { environmentId: "env-1", threadId: "thread-1" },
        });
      }
    },
  );

  it.each(["current-thread", "in-app-off", "focus-cleanup", "off", "unmount"] as const)(
    "does not replay an in-app fallback after %s while native delivery is pending",
    async (change) => {
      state.mode = "notifications";
      state.preferences = { notificationFocusRule: "always" };
      let reply!: (delivered: boolean) => void;
      Object.assign(window, {
        desktopBridge: {
          showThreadNotification: vi.fn(
            () =>
              new Promise<boolean>((resolve) => {
                reply = resolve;
              }),
          ),
          closeThreadNotification: vi.fn(() => Promise.resolve()),
        },
      });
      await render();
      await complete();
      if (change === "current-thread") {
        state.active = { environmentId: "env-1", threadId: "thread-1" };
        await render();
      } else if (change === "in-app-off") {
        state.inApp = false;
        await render();
      } else if (change === "focus-cleanup") {
        await act(() => {
          window.dispatchEvent(new Event("focus"));
        });
      } else if (change === "off") {
        state.mode = "off";
        await render();
      } else {
        await act(() => renderer?.unmount());
        renderer = undefined;
      }
      await act(() => reply(false));
      expect(state.add).not.toHaveBeenCalled();
      expect(state.badge).toHaveBeenLastCalledWith(0);
    },
  );

  it.each(["denied", "default", "unavailable"] as const)(
    "keeps the foreground in-app fallback when browser delivery is %s",
    async (permission) => {
      state.mode = "notifications";
      state.preferences = { notificationFocusRule: "always" };
      if (permission === "unavailable") vi.stubGlobal("Notification", undefined);
      else vi.stubGlobal("Notification", Object.assign(state.notification, { permission }));
      await render();
      await complete();
      expect(state.notification).not.toHaveBeenCalled();
      expect(state.add).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Thread completed" }),
      );
    },
  );

  it("uses the native bridge before considering denied browser permission", async () => {
    state.mode = "notifications";
    state.preferences = { notificationFocusRule: "always" };
    vi.stubGlobal("Notification", Object.assign(state.notification, { permission: "denied" }));
    const native = nativeFixture();
    await render();
    await complete();
    expect(native.active.size).toBe(1);
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).not.toHaveBeenCalled();
  });
});
