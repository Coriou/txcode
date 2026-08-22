import type { ShowThreadNotificationInput } from "@t3tools/contracts";
import type { ThreadNotificationTrigger } from "@t3tools/client-runtime/state/threadNotifications";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Module-level flags/mocks the module under test resolves at call time.
const envState = vi.hoisted(() => ({ isElectron: false }));
const navigate = vi.hoisted(() => vi.fn());

// A getter, not a plain property: the mock module is created once at import,
// and the tests flip envState per test — the module under test must see the
// CURRENT value of its isElectron branch condition, mirroring env.ts's
// window.desktopBridge presence check.
vi.mock("../env", () => ({
  get isElectron() {
    return envState.isElectron;
  },
}));
vi.mock("../router", () => ({ getActiveRouter: () => ({ navigate }) }));

import {
  presentThreadNotification,
  summarizeThreadNotifications,
} from "./deliverThreadNotification";

// Typed so mock.calls reads stay fully checked.
const showThreadNotification = vi.fn<(input: ShowThreadNotificationInput) => Promise<void>>();

const focusSpy = vi.fn();
const windowStub: { focus: typeof focusSpy; desktopBridge?: unknown } = {
  focus: focusSpy,
};

class FakeNotification {
  static permission: string = "granted";
  static instances: Array<FakeNotification> = [];

  onclick: (() => void) | null = null;

  constructor(
    readonly title: string,
    readonly options?: { body?: string; tag?: string },
  ) {
    FakeNotification.instances.push(this);
  }

  close(): void {}
}

const trigger: ThreadNotificationTrigger = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("t1"),
  kind: "turn-completed",
  dedupeKey: "t1:turn-completed:turn-1:2026-08-22T12:00:00.000Z",
  threadTitle: "Fix the bug",
  occurredAt: "2026-08-22T12:00:00.000Z",
};

const presentation = { title: "Fix the bug", body: "Turn completed" };

function enableDesktopBridge(): void {
  envState.isElectron = true;
  windowStub.desktopBridge = { showThreadNotification };
}

beforeEach(() => {
  envState.isElectron = false;
  navigate.mockReset();
  showThreadNotification.mockReset();
  FakeNotification.instances = [];
  FakeNotification.permission = "granted";
  // Tests run in a node environment: stub the browser globals the module uses.
  vi.stubGlobal("Notification", FakeNotification);
  focusSpy.mockReset();
  windowStub.desktopBridge = undefined;
  vi.stubGlobal("window", windowStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("presentThreadNotification", () => {
  it("creates a browser Notification tagged with the dedupeKey", () => {
    presentThreadNotification(trigger, presentation);

    expect(FakeNotification.instances).toHaveLength(1);
    const notification = FakeNotification.instances[0]!;
    expect(notification.title).toBe("Fix the bug");
    expect(notification.options).toEqual({ body: "Turn completed", tag: trigger.dedupeKey });
    expect(showThreadNotification).not.toHaveBeenCalled();
  });

  it("navigates to the scoped thread on click", () => {
    presentThreadNotification(trigger, presentation);

    FakeNotification.instances[0]!.onclick?.();

    expect(windowStub.focus).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: trigger.environmentId, threadId: trigger.threadId },
    });
  });

  it("stays silent when browser notification permission was not granted", () => {
    FakeNotification.permission = "denied";

    presentThreadNotification(trigger, presentation);

    expect(FakeNotification.instances).toHaveLength(0);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("routes through desktopBridge.showThreadNotification in Electron", () => {
    enableDesktopBridge();

    presentThreadNotification(trigger, presentation);

    expect(showThreadNotification).toHaveBeenCalledWith({
      title: "Fix the bug",
      body: "Turn completed",
      threadRef: { environmentId: trigger.environmentId, threadId: trigger.threadId },
    });
    expect(FakeNotification.instances).toHaveLength(0);
  });
});

describe("summarizeThreadNotifications", () => {
  it("routes summaries through desktopBridge without a threadRef in Electron", () => {
    enableDesktopBridge();

    summarizeThreadNotifications(4);

    expect(showThreadNotification).toHaveBeenCalledTimes(1);
    const input = showThreadNotification.mock.calls[0]![0];
    expect(input.title).toBe("Threads need your attention");
    expect(input.body).toBe("4 threads have updates.");
    expect(input.threadRef).toBeUndefined();
    expect(Object.hasOwn(input, "threadRef")).toBe(false);
  });

  it("shows an untagged summary Notification in the browser", () => {
    summarizeThreadNotifications(4);

    expect(FakeNotification.instances).toHaveLength(1);
    const notification = FakeNotification.instances[0]!;
    expect(notification.options).toEqual({ body: "4 threads have updates." });
  });

  it("closes the summary and refocuses on click", () => {
    const close = vi.spyOn(FakeNotification.prototype, "close");

    summarizeThreadNotifications(4);
    FakeNotification.instances[0]!.onclick?.();

    expect(close).toHaveBeenCalled();
    expect(windowStub.focus).toHaveBeenCalled();
  });

  it("stays silent without browser notification permission", () => {
    FakeNotification.permission = "denied";

    summarizeThreadNotifications(4);

    expect(FakeNotification.instances).toHaveLength(0);
  });
});
