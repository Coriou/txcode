import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationLatestTurn,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  MAX_TRIGGERS_PER_BATCH,
  THROTTLE_MS,
  diffThreadNotificationTriggers,
  shouldDeliverThreadNotification,
  summarizeThreadNotificationTriggers,
  type ThreadNotificationSettings,
} from "./threadNotifications.ts";

const NOW = "2026-08-22T12:00:00.000Z";
const environmentA = EnvironmentId.make("environment-a");

let seq = 0;
function makeShell(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  seq += 1;
  const threadId = ThreadId.make(`thread-${seq}`);
  return {
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: `Thread ${seq}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function snapshot(threads: OrchestrationThreadShell[]): OrchestrationShellSnapshot {
  return { snapshotSequence: threads.length, projects: [], threads, updatedAt: NOW };
}

function turn(input: {
  readonly turnId?: string;
  readonly state: OrchestrationLatestTurn["state"];
  readonly completedAt?: string | null;
}): OrchestrationLatestTurn {
  return {
    turnId: TurnId.make(input.turnId ?? "turn-1"),
    state: input.state,
    requestedAt: NOW,
    startedAt: NOW,
    completedAt: input.completedAt ?? null,
    assistantMessageId: null,
  };
}

describe("diffThreadNotificationTriggers", () => {
  it("returns [] when previous snapshot is null (bootstrap)", () => {
    expect(
      diffThreadNotificationTriggers({
        environmentId: environmentA,
        previous: null,
        next: snapshot([makeShell({ latestTurn: turn({ state: "completed", completedAt: NOW }) })]),
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("returns [] when next snapshot is null", () => {
    expect(
      diffThreadNotificationTriggers({
        environmentId: environmentA,
        previous: snapshot([makeShell({ latestTurn: turn({ state: "running" }) })]),
        next: null,
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("fires turn-completed on running->completed with dedupeKey <id>:turn-completed:<turnId>:<completedAt>", () => {
    const threadId = ThreadId.make("t1");
    const triggers = diffThreadNotificationTriggers({
      environmentId: environmentA,
      previous: snapshot([
        makeShell({ id: threadId, title: "Fix the bug", latestTurn: turn({ state: "running" }) }),
      ]),
      next: snapshot([
        makeShell({
          id: threadId,
          title: "Fix the bug",
          latestTurn: turn({ state: "completed", completedAt: NOW }),
        }),
      ]),
      now: NOW,
    });
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({
      environmentId: environmentA,
      threadId,
      kind: "turn-completed",
      dedupeKey: `t1:turn-completed:turn-1:${NOW}`,
      threadTitle: "Fix the bug",
      occurredAt: NOW,
    });
  });

  it("fires turn-failed on running->error", () => {
    const threadId = ThreadId.make("t1");
    const triggers = diffThreadNotificationTriggers({
      environmentId: environmentA,
      previous: snapshot([makeShell({ id: threadId, latestTurn: turn({ state: "running" }) })]),
      next: snapshot([
        makeShell({ id: threadId, latestTurn: turn({ state: "error", completedAt: NOW }) }),
      ]),
      now: NOW,
    });
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({
      kind: "turn-failed",
      dedupeKey: `t1:turn-failed:turn-1:${NOW}`,
    });
  });

  it("stays silent on running->interrupted (user-initiated)", () => {
    const threadId = ThreadId.make("t1");
    expect(
      diffThreadNotificationTriggers({
        environmentId: environmentA,
        previous: snapshot([makeShell({ id: threadId, latestTurn: turn({ state: "running" }) })]),
        next: snapshot([
          makeShell({ id: threadId, latestTurn: turn({ state: "interrupted", completedAt: NOW }) }),
        ]),
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("does not refire when state stays completed", () => {
    const threadId = ThreadId.make("t1");
    const settled = makeShell({
      id: threadId,
      latestTurn: turn({ state: "completed", completedAt: NOW }),
    });
    expect(
      diffThreadNotificationTriggers({
        environmentId: environmentA,
        previous: snapshot([settled]),
        next: snapshot([settled]),
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("ignores completion of a turn we never saw running (different turnId)", () => {
    const threadId = ThreadId.make("t1");
    expect(
      diffThreadNotificationTriggers({
        environmentId: environmentA,
        previous: snapshot([
          makeShell({ id: threadId, latestTurn: turn({ turnId: "turn-1", state: "running" }) }),
        ]),
        next: snapshot([
          makeShell({
            id: threadId,
            latestTurn: turn({ turnId: "turn-2", state: "completed", completedAt: NOW }),
          }),
        ]),
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("fires approval-requested once on false->true edge with dedupeKey <id>:approval-requested:<turnId>", () => {
    const threadId = ThreadId.make("t1");
    const triggers = diffThreadNotificationTriggers({
      environmentId: environmentA,
      previous: snapshot([makeShell({ id: threadId, latestTurn: turn({ state: "running" }) })]),
      next: snapshot([
        makeShell({
          id: threadId,
          hasPendingApprovals: true,
          latestTurn: turn({ state: "running" }),
        }),
      ]),
      now: NOW,
    });
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({
      kind: "approval-requested",
      dedupeKey: "t1:approval-requested:turn-1",
    });
  });

  it("stays silent while approvals stay pending (no re-edge)", () => {
    const threadId = ThreadId.make("t1");
    const pending = makeShell({
      id: threadId,
      hasPendingApprovals: true,
      latestTurn: turn({ state: "running" }),
    });
    expect(
      diffThreadNotificationTriggers({
        environmentId: environmentA,
        previous: snapshot([pending]),
        next: snapshot([pending]),
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("fires input-requested on user-input false->true", () => {
    const threadId = ThreadId.make("t1");
    const triggers = diffThreadNotificationTriggers({
      environmentId: environmentA,
      previous: snapshot([makeShell({ id: threadId, latestTurn: turn({ state: "running" }) })]),
      next: snapshot([
        makeShell({
          id: threadId,
          hasPendingUserInput: true,
          latestTurn: turn({ state: "running" }),
        }),
      ]),
      now: NOW,
    });
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({
      kind: "input-requested",
      dedupeKey: "t1:input-requested:turn-1",
    });
  });

  it("suppresses threads that are archived in next", () => {
    const threadId = ThreadId.make("t1");
    expect(
      diffThreadNotificationTriggers({
        environmentId: environmentA,
        previous: snapshot([makeShell({ id: threadId, latestTurn: turn({ state: "running" }) })]),
        next: snapshot([
          makeShell({
            id: threadId,
            hasPendingApprovals: true,
            archivedAt: NOW,
            latestTurn: turn({ state: "running" }),
          }),
        ]),
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("suppresses threads that just became archived even with a completion edge", () => {
    const threadId = ThreadId.make("t1");
    expect(
      diffThreadNotificationTriggers({
        environmentId: environmentA,
        previous: snapshot([makeShell({ id: threadId, latestTurn: turn({ state: "running" }) })]),
        next: snapshot([
          makeShell({
            id: threadId,
            archivedAt: NOW,
            latestTurn: turn({ state: "completed", completedAt: NOW }),
          }),
        ]),
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("suppresses snoozed threads without raised hand", () => {
    const threadId = ThreadId.make("t1");
    // The turn completed BEFORE the snooze was set: the user saw it and
    // snoozed anyway, so nothing about this thread raises a hand.
    expect(
      diffThreadNotificationTriggers({
        environmentId: environmentA,
        previous: snapshot([makeShell({ id: threadId, latestTurn: turn({ state: "running" }) })]),
        next: snapshot([
          makeShell({
            id: threadId,
            snoozedUntil: "2026-08-22T18:00:00.000Z",
            snoozedAt: "2026-08-22T11:30:00.000Z",
            latestTurn: turn({ state: "completed", completedAt: "2026-08-22T11:00:00.000Z" }),
          }),
        ]),
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("notifies a snoozed thread that raises its hand (pending approval)", () => {
    const threadId = ThreadId.make("t1");
    const triggers = diffThreadNotificationTriggers({
      environmentId: environmentA,
      previous: snapshot([makeShell({ id: threadId, latestTurn: turn({ state: "running" }) })]),
      next: snapshot([
        makeShell({
          id: threadId,
          snoozedUntil: "2026-08-22T18:00:00.000Z",
          snoozedAt: "2026-08-22T10:00:00.000Z",
          hasPendingApprovals: true,
          latestTurn: turn({ state: "running" }),
        }),
      ]),
      now: NOW,
    });
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.kind).toBe("approval-requested");
  });

  it("preserves next-snapshot thread order across multiple triggers", () => {
    const first = ThreadId.make("t1");
    const second = ThreadId.make("t2");
    const triggers = diffThreadNotificationTriggers({
      environmentId: environmentA,
      previous: snapshot([
        makeShell({ id: first, latestTurn: turn({ state: "running" }) }),
        makeShell({ id: second, latestTurn: turn({ state: "running" }) }),
      ]),
      next: snapshot([
        makeShell({ id: first, latestTurn: turn({ state: "completed", completedAt: NOW }) }),
        makeShell({ id: second, latestTurn: turn({ state: "error", completedAt: NOW }) }),
      ]),
      now: NOW,
    });
    expect(triggers.map((trigger) => trigger.threadId)).toEqual([first, second]);
    expect(triggers.map((trigger) => trigger.kind)).toEqual(["turn-completed", "turn-failed"]);
  });
});

describe("shouldDeliverThreadNotification", () => {
  const settings = (
    overrides: Partial<ThreadNotificationSettings> = {},
  ): ThreadNotificationSettings => ({
    notifyOnTurnCompleted: true,
    notifyOnFailure: true,
    notifyOnApprovalRequested: true,
    notifyOnUserInputRequested: true,
    notificationFocusRule: "unfocused-or-different-thread",
    ...overrides,
  });
  const trigger = {
    kind: "turn-completed" as const,
    threadId: ThreadId.make("t1"),
  };
  const unfocused = { focused: false, activeThreadId: null };

  it("blocks when the kind's toggle is off", () => {
    expect(
      shouldDeliverThreadNotification({
        trigger,
        settings: settings({ notifyOnTurnCompleted: false }),
        context: unfocused,
      }),
    ).toBe(false);
  });

  it("focus rule always delivers even when focused on the same thread", () => {
    expect(
      shouldDeliverThreadNotification({
        trigger,
        settings: settings({ notificationFocusRule: "always" }),
        context: { focused: true, activeThreadId: trigger.threadId },
      }),
    ).toBe(true);
  });

  it("focus rule unfocused blocks while focused regardless of thread", () => {
    expect(
      shouldDeliverThreadNotification({
        trigger,
        settings: settings({ notificationFocusRule: "unfocused" }),
        context: { focused: true, activeThreadId: null },
      }),
    ).toBe(false);
  });

  it("focus rule unfocused-or-different-thread blocks same focused thread", () => {
    expect(
      shouldDeliverThreadNotification({
        trigger,
        settings: settings(),
        context: { focused: true, activeThreadId: trigger.threadId },
      }),
    ).toBe(false);
  });

  it("focus rule unfocused-or-different-thread delivers different focused thread", () => {
    expect(
      shouldDeliverThreadNotification({
        trigger,
        settings: settings(),
        context: { focused: true, activeThreadId: ThreadId.make("other") },
      }),
    ).toBe(true);
  });

  it("delivers when window is unfocused under any rule", () => {
    for (const notificationFocusRule of [
      "always",
      "unfocused",
      "unfocused-or-different-thread",
    ] as const) {
      expect(
        shouldDeliverThreadNotification({
          trigger,
          settings: settings({ notificationFocusRule }),
          context: unfocused,
        }),
      ).toBe(true);
    }
  });
});

describe("summarizeThreadNotificationTriggers", () => {
  const trigger = {
    environmentId: environmentA,
    threadId: ThreadId.make("t1"),
    kind: "turn-completed" as const,
    dedupeKey: "k",
    threadTitle: "T",
    occurredAt: NOW,
  };

  it("passes small batches through", () => {
    const batch = [trigger, trigger];
    expect(summarizeThreadNotificationTriggers(batch)).toEqual({
      triggers: batch,
      summaryCount: 0,
    });
  });

  it(`collapses batches over ${MAX_TRIGGERS_PER_BATCH} into a summary with count`, () => {
    const batch = [trigger, trigger, trigger, trigger, trigger];
    expect(summarizeThreadNotificationTriggers(batch)).toEqual({
      triggers: [],
      summaryCount: 5,
    });
  });

  it("exposes MAX_TRIGGERS_PER_BATCH = 3 and THROTTLE_MS = 5000", () => {
    expect(MAX_TRIGGERS_PER_BATCH).toBe(3);
    expect(THROTTLE_MS).toBe(5000);
  });
});
