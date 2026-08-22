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
import type {
  ThreadNotificationSettings,
  ThreadNotificationTrigger,
} from "@t3tools/client-runtime/state/threadNotifications";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// The observer's DEFAULT deps reach into the app graph (router -> routeTree ->
// every route file). Tests inject every dep, so stub those modules to keep
// this suite a pure unit test.
vi.mock("../router", () => ({ getActiveRouter: () => null }));
vi.mock("../state/shell", () => ({
  environmentSnapshotAtom: () => {
    throw new Error("snapshotAtom must be injected in tests");
  },
}));
vi.mock("../hooks/useSettings", () => ({
  getClientSettings: () => {
    throw new Error("readSettings must be injected in tests");
  },
}));

import { setActiveThreadRoute } from "./activeThreadRoute";
import { installThreadNotifications } from "./threadNotificationObserver";

const NOW = "2026-08-22T12:00:00.000Z";
const environmentA = EnvironmentId.make("environment-a");
const environmentB = EnvironmentId.make("environment-b");

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

function makeSettings(
  overrides: Partial<ThreadNotificationSettings> = {},
): ThreadNotificationSettings {
  return {
    notifyOnTurnCompleted: true,
    notifyOnFailure: true,
    notifyOnApprovalRequested: true,
    notifyOnUserInputRequested: true,
    notificationFocusRule: "unfocused-or-different-thread",
    ...overrides,
  };
}

type DeliverFn = (triggers: ReadonlyArray<ThreadNotificationTrigger>, summaryCount: number) => void;

interface HarnessOptions {
  readonly settings?: ThreadNotificationSettings;
  readonly focused?: boolean;
  /** Injectable wall clock (ISO string); defaults to a fixed instant. */
  readonly now?: () => string;
}

interface Harness {
  readonly deliver: DeliverFn & {
    mock: { calls: Array<[ReadonlyArray<ThreadNotificationTrigger>, number]> };
  };
  setCatalog(environmentIds: ReadonlyArray<EnvironmentId>): void;
  setSnapshot(environmentId: EnvironmentId, next: OrchestrationShellSnapshot | null): void;
  cleanup(): void;
}

/** First deliver call or a loud failure, sidestepping indexed-access undefined. */
function firstDeliverCall(harness: Harness): [ReadonlyArray<ThreadNotificationTrigger>, number] {
  const call = harness.deliver.mock.calls.at(0);
  if (!call) {
    throw new Error("expected deliver to have been called");
  }
  return call;
}

function installHarness(options: HarnessOptions = {}): Harness {
  const registry = AtomRegistry.make();
  const settings = options.settings ?? makeSettings();
  const focused = options.focused ?? false;
  const now = options.now ?? (() => NOW);
  const deliver = vi.fn<DeliverFn>();

  const catalogAtom = Atom.make<{ isReady: boolean; entries: ReadonlyMap<EnvironmentId, unknown> }>(
    { isReady: true, entries: new Map() },
  );
  const environmentAtoms = new Map<
    EnvironmentId,
    Atom.Writable<OrchestrationShellSnapshot | null>
  >();
  const snapshotAtom = (
    environmentId: EnvironmentId,
  ): Atom.Writable<OrchestrationShellSnapshot | null> => {
    let atom = environmentAtoms.get(environmentId);
    if (atom === undefined) {
      atom = Atom.make<OrchestrationShellSnapshot | null>(null);
      environmentAtoms.set(environmentId, atom);
    }
    return atom;
  };

  const cleanup = installThreadNotifications({
    registry,
    catalogValueAtom: catalogAtom as never,
    snapshotAtom,
    readSettings: () => settings,
    focused: () => focused,
    now,
    deliver: deliver as unknown as DeliverFn,
  });

  return {
    deliver: deliver as DeliverFn & Harness["deliver"],
    setCatalog(ids) {
      registry.set(catalogAtom, {
        isReady: true,
        entries: new Map(ids.map((id) => [id, {}])),
      });
    },
    setSnapshot(environmentId, next) {
      registry.set(snapshotAtom(environmentId), next);
    },
    cleanup,
  };
}

afterEach(() => {
  setActiveThreadRoute(null);
});

describe("installThreadNotifications", () => {
  it("never notifies on the first observation of an environment (baseline arming)", () => {
    const harness = installHarness();

    harness.setCatalog([environmentA]);
    harness.setSnapshot(
      environmentA,
      snapshot([makeShell({ latestTurn: turn({ state: "completed", completedAt: NOW }) })]),
    );

    expect(harness.deliver).not.toHaveBeenCalled();
    harness.cleanup();
  });

  it("delivers turn-completed on a rising edge after the baseline", async () => {
    const harness = installHarness();
    const threadId = ThreadId.make("t1");

    harness.setCatalog([environmentA]);
    harness.setSnapshot(
      environmentA,
      snapshot([
        makeShell({ id: threadId, title: "Fix the bug", latestTurn: turn({ state: "running" }) }),
      ]),
    );
    harness.setSnapshot(
      environmentA,
      snapshot([
        makeShell({
          id: threadId,
          title: "Fix the bug",
          latestTurn: turn({ state: "completed", completedAt: NOW }),
        }),
      ]),
    );

    await vi.waitFor(() => expect(harness.deliver).toHaveBeenCalledTimes(1));
    const [triggers, summaryCount] = firstDeliverCall(harness);
    expect(summaryCount).toBe(0);
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({
      environmentId: environmentA,
      threadId,
      kind: "turn-completed",
      dedupeKey: `t1:turn-completed:turn-1:${NOW}`,
      threadTitle: "Fix the bug",
    });
    harness.cleanup();
  });

  it("blocks when the kind's toggle is off", () => {
    const harness = installHarness({
      settings: makeSettings({ notifyOnTurnCompleted: false }),
    });
    const threadId = ThreadId.make("t1");

    harness.setCatalog([environmentA]);
    harness.setSnapshot(
      environmentA,
      snapshot([makeShell({ id: threadId, latestTurn: turn({ state: "running" }) })]),
    );
    harness.setSnapshot(
      environmentA,
      snapshot([
        makeShell({ id: threadId, latestTurn: turn({ state: "completed", completedAt: NOW }) }),
      ]),
    );

    expect(harness.deliver).not.toHaveBeenCalled();
    harness.cleanup();
  });

  it("blocks a notification for the thread the user is viewing while focused", () => {
    const threadId = ThreadId.make("t1");
    const harness = installHarness({ focused: true });

    harness.setCatalog([environmentA]);
    harness.setSnapshot(
      environmentA,
      snapshot([
        makeShell({ id: threadId, title: "Viewed", latestTurn: turn({ state: "running" }) }),
      ]),
    );
    setActiveThreadRoute({ environmentId: environmentA, threadId });
    harness.setSnapshot(
      environmentA,
      snapshot([
        makeShell({
          id: threadId,
          title: "Viewed",
          latestTurn: turn({ state: "completed", completedAt: NOW }),
        }),
      ]),
    );

    expect(harness.deliver).not.toHaveBeenCalled();
    harness.cleanup();
  });

  it("delivers when focus rule allows a different viewed thread", async () => {
    const threadId = ThreadId.make("t1");
    const otherThreadId = ThreadId.make("other");
    const harness = installHarness({ focused: true });

    harness.setCatalog([environmentA]);
    harness.setSnapshot(
      environmentA,
      snapshot([
        makeShell({
          id: threadId,
          title: "Background thread",
          latestTurn: turn({ state: "running" }),
        }),
      ]),
    );
    setActiveThreadRoute({ environmentId: environmentA, threadId: otherThreadId });
    harness.setSnapshot(
      environmentA,
      snapshot([
        makeShell({
          id: threadId,
          title: "Background thread",
          latestTurn: turn({ state: "completed", completedAt: NOW }),
        }),
      ]),
    );

    await vi.waitFor(() => expect(harness.deliver).toHaveBeenCalledTimes(1));
    const [triggers] = firstDeliverCall(harness);
    expect(triggers[0]).toMatchObject({ threadId, kind: "turn-completed" });
    harness.cleanup();
  });

  it("drops a replayed edge whose dedupeKey was already shown", async () => {
    const threadId = ThreadId.make("t1");
    const running = () =>
      snapshot([makeShell({ id: threadId, latestTurn: turn({ state: "running" }) })]);
    const completed = () =>
      snapshot([
        makeShell({ id: threadId, latestTurn: turn({ state: "completed", completedAt: NOW }) }),
      ]);

    const harness = installHarness();
    harness.setCatalog([environmentA]);
    // Baseline.
    harness.setSnapshot(environmentA, running());
    // First completion delivers.
    harness.setSnapshot(environmentA, completed());
    await vi.waitFor(() => expect(harness.deliver).toHaveBeenCalledTimes(1));
    // WS replay: back to running (no edge), then the same completion again
    // produces an identical dedupeKey — it must be dropped.
    harness.setSnapshot(environmentA, running());
    harness.setSnapshot(environmentA, completed());
    expect(harness.deliver).toHaveBeenCalledTimes(1);
    harness.cleanup();
  });

  it("observes an environment added to the catalog after install", async () => {
    const harness = installHarness();
    const shellA = makeShell({ latestTurn: turn({ state: "running" }) });

    harness.setCatalog([environmentA]);
    harness.setSnapshot(environmentA, snapshot([shellA]));

    harness.setCatalog([environmentA, environmentB]);
    // Baseline for B first.
    const shellB = makeShell({ latestTurn: turn({ state: "running" }) });
    harness.setSnapshot(environmentB, snapshot([shellB]));
    harness.setSnapshot(
      environmentB,
      snapshot([
        makeShell({
          id: shellB.id,
          latestTurn: turn({ state: "error", completedAt: NOW }),
        }),
      ]),
    );

    await vi.waitFor(() => expect(harness.deliver).toHaveBeenCalledTimes(1));
    const [triggers] = firstDeliverCall(harness);
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({ environmentId: environmentB, kind: "turn-failed" });
    harness.cleanup();
  });

  it("drops batches inside the global throttle window and resumes after it", async () => {
    let current = Date.parse(NOW);
    const harness = installHarness({ now: () => new Date(current).toISOString() });

    harness.setCatalog([environmentA]);
    const first = makeShell({ title: "First", latestTurn: turn({ state: "running" }) });
    harness.setSnapshot(environmentA, snapshot([first]));
    harness.setSnapshot(
      environmentA,
      snapshot([
        makeShell({
          id: first.id,
          title: "First",
          latestTurn: turn({ state: "completed", completedAt: NOW }),
        }),
      ]),
    );
    await vi.waitFor(() => expect(harness.deliver).toHaveBeenCalledTimes(1));

    // Second edge inside the 5s window: dropped entirely.
    current += 1_000;
    harness.setSnapshot(
      environmentA,
      snapshot([
        makeShell({
          id: first.id,
          latestTurn: turn({ turnId: "turn-2", state: "running" }),
        }),
      ]),
    );
    harness.setSnapshot(
      environmentA,
      snapshot([
        makeShell({
          id: first.id,
          latestTurn: turn({ turnId: "turn-2", state: "error", completedAt: NOW }),
        }),
      ]),
    );
    expect(harness.deliver).toHaveBeenCalledTimes(1);

    // Third edge outside the window: delivered.
    current += 5_000;
    harness.setSnapshot(
      environmentA,
      snapshot([
        makeShell({
          id: first.id,
          latestTurn: turn({ turnId: "turn-3", state: "running" }),
        }),
      ]),
    );
    harness.setSnapshot(
      environmentA,
      snapshot([
        makeShell({
          id: first.id,
          latestTurn: turn({ turnId: "turn-3", state: "completed", completedAt: NOW }),
        }),
      ]),
    );
    await vi.waitFor(() => expect(harness.deliver).toHaveBeenCalledTimes(2));
    harness.cleanup();
  });

  it("collapses more than MAX_TRIGGERS_PER_BATCH triggers into one summary", async () => {
    const harness = installHarness();

    harness.setCatalog([environmentA]);
    const runningThreads = [
      makeShell({ title: "One", latestTurn: turn({ state: "running" }) }),
      makeShell({ title: "Two", latestTurn: turn({ state: "running" }) }),
      makeShell({ title: "Three", latestTurn: turn({ state: "running" }) }),
      makeShell({ title: "Four", latestTurn: turn({ state: "running" }) }),
    ];
    harness.setSnapshot(environmentA, snapshot(runningThreads));
    harness.setSnapshot(
      environmentA,
      snapshot(
        runningThreads.map((shell) =>
          makeShell({
            id: shell.id,
            title: shell.title,
            latestTurn: turn({ state: "completed", completedAt: NOW }),
          }),
        ),
      ),
    );

    await vi.waitFor(() => expect(harness.deliver).toHaveBeenCalledTimes(1));
    const [triggers, summaryCount] = firstDeliverCall(harness);
    expect(triggers).toEqual([]);
    expect(summaryCount).toBe(runningThreads.length);
    harness.cleanup();
  });

  it("returns a cleanup that fully unwinds subscriptions", () => {
    const harness = installHarness();

    harness.setCatalog([environmentA]);
    harness.setSnapshot(
      environmentA,
      snapshot([makeShell({ latestTurn: turn({ state: "running" }) })]),
    );
    harness.cleanup();

    harness.setSnapshot(
      environmentA,
      snapshot([makeShell({ latestTurn: turn({ state: "completed", completedAt: NOW }) })]),
    );

    expect(harness.deliver).not.toHaveBeenCalled();
  });

  it("delivers again once the dedupe-key TTL has expired", async () => {
    let current = Date.parse(NOW);
    const threadId = ThreadId.make("t1");
    const running = () =>
      snapshot([makeShell({ id: threadId, latestTurn: turn({ state: "running" }) })]);
    const completed = () =>
      snapshot([
        makeShell({ id: threadId, latestTurn: turn({ state: "completed", completedAt: NOW }) }),
      ]);

    const harness = installHarness({ now: () => new Date(current).toISOString() });
    harness.setCatalog([environmentA]);
    harness.setSnapshot(environmentA, running());
    harness.setSnapshot(environmentA, completed());
    await vi.waitFor(() => expect(harness.deliver).toHaveBeenCalledTimes(1));

    // Advance past SHOWN_KEY_TTL_MS (5 x THROTTLE_MS = 25s); the identical
    // edge replays with the same dedupeKey but the key was pruned.
    current += 25_000;
    harness.setSnapshot(environmentA, running());
    harness.setSnapshot(environmentA, completed());
    await vi.waitFor(() => expect(harness.deliver).toHaveBeenCalledTimes(2));
    const replayCall = harness.deliver.mock.calls.at(1);
    if (!replayCall) {
      throw new Error("expected a second deliver call");
    }
    expect(replayCall[1]).toBe(0);
    harness.cleanup();
  });

  it("ignores updates from a removed environment and re-arms silently when re-added", () => {
    const harness = installHarness();
    const shellB = makeShell({ title: "Env B thread", latestTurn: turn({ state: "running" }) });

    harness.setCatalog([environmentA, environmentB]);
    harness.setSnapshot(environmentA, snapshot([makeShell({ id: shellB.id })]));
    harness.setSnapshot(environmentB, snapshot([shellB]));

    // Remove B from the catalog: its edges are invisible while unsubscribed.
    harness.setCatalog([environmentA]);
    harness.setSnapshot(
      environmentB,
      snapshot([
        makeShell({ id: shellB.id, latestTurn: turn({ state: "error", completedAt: NOW }) }),
      ]),
    );
    expect(harness.deliver).not.toHaveBeenCalled();

    // Re-add B: the first observation re-arms the baseline, never notifies.
    harness.setCatalog([environmentA, environmentB]);
    harness.setSnapshot(environmentB, snapshot([shellB]));
    expect(harness.deliver).not.toHaveBeenCalled();
    harness.cleanup();
  });

  it("throttles across environments: one delivery per THROTTLE_MS globally", async () => {
    const harness = installHarness();
    const shellA = makeShell({ title: "A", latestTurn: turn({ state: "running" }) });
    const shellB = makeShell({ title: "B", latestTurn: turn({ state: "running" }) });

    harness.setCatalog([environmentA, environmentB]);
    harness.setSnapshot(environmentA, snapshot([shellA]));
    harness.setSnapshot(environmentB, snapshot([shellB]));
    // Env A's edge delivers first...
    harness.setSnapshot(
      environmentA,
      snapshot([
        makeShell({
          id: shellA.id,
          title: "A",
          latestTurn: turn({ state: "completed", completedAt: NOW }),
        }),
      ]),
    );
    await vi.waitFor(() => expect(harness.deliver).toHaveBeenCalledTimes(1));
    // ...and env B's edge inside the same window is dropped by the GLOBAL throttle.
    harness.setSnapshot(
      environmentB,
      snapshot([
        makeShell({
          id: shellB.id,
          title: "B",
          latestTurn: turn({ state: "error", completedAt: NOW }),
        }),
      ]),
    );
    expect(harness.deliver).toHaveBeenCalledTimes(1);
    harness.cleanup();
  });
});
