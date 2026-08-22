import type {
  ClientSettings,
  EnvironmentId,
  OrchestrationShellSnapshot,
  ThreadId,
} from "@t3tools/contracts";

import { effectiveSnoozed } from "./threadSettled.ts";

/**
 * What a thread notification is about. Derived purely from rising edges
 * between consecutive shell snapshots; one trigger per observable event.
 */
export type ThreadNotificationKind =
  | "turn-completed"
  | "turn-failed"
  | "approval-requested"
  | "input-requested";

export interface ThreadNotificationTrigger {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly kind: ThreadNotificationKind;
  /** Idempotent across WS replays: `<threadId>:<kind>:<turnId>[:<completedAt>]`. */
  readonly dedupeKey: string;
  readonly threadTitle: string;
  readonly occurredAt: string;
}

/** Structural slice of ClientSettings the gate needs (avoids dragging the full type around). */
export type ThreadNotificationSettings = Pick<
  ClientSettings,
  | "notifyOnTurnCompleted"
  | "notifyOnFailure"
  | "notifyOnApprovalRequested"
  | "notifyOnUserInputRequested"
  | "notificationFocusRule"
>;

/** Minimum spacing between any two delivered notifications, per client. */
export const THROTTLE_MS = 5_000;
/** More simultaneous triggers than this collapse into a single summary notification. */
export const MAX_TRIGGERS_PER_BATCH = 3;

/**
 * Rising-edge derivation over two consecutive shell snapshots. Both snapshots
 * must exist: a null previous or next means bootstrap/reseed and yields no
 * triggers (PR #1780's stale-set bug is structurally impossible here because
 * nothing accumulates between calls).
 *
 * Output order follows next-snapshot thread order; per-thread order is
 * approval, input request, then turn terminal state.
 */
export function diffThreadNotificationTriggers(input: {
  readonly environmentId: EnvironmentId;
  readonly previous: OrchestrationShellSnapshot | null;
  readonly next: OrchestrationShellSnapshot | null;
  readonly now: string;
}): Array<ThreadNotificationTrigger> {
  const { environmentId, previous, next, now } = input;
  if (!previous || !next) return [];

  const previousById = new Map(previous.threads.map((shell) => [shell.id, shell]));
  const triggers: Array<ThreadNotificationTrigger> = [];

  for (const shell of next.threads) {
    const before = previousById.get(shell.id);
    if (!before) continue; // brand-new shells never notify
    // Archived threads are dead: never notify, even on the same diff that
    // archives them (the archive IS the user's acknowledgment).
    if (shell.archivedAt != null) continue;
    // Snoozed threads stay silent unless they raised their hand; effectiveSnoozed
    // folds the raise-hand check in via threadRaisedHandWhileSnoozed.
    if (effectiveSnoozed(shell, { now })) continue;

    const turnId = shell.latestTurn?.turnId ?? "none";

    if (!before.hasPendingApprovals && shell.hasPendingApprovals) {
      triggers.push({
        environmentId,
        threadId: shell.id,
        kind: "approval-requested",
        dedupeKey: `${shell.id}:approval-requested:${turnId}`,
        threadTitle: shell.title,
        occurredAt: now,
      });
    }
    if (!before.hasPendingUserInput && shell.hasPendingUserInput) {
      triggers.push({
        environmentId,
        threadId: shell.id,
        kind: "input-requested",
        dedupeKey: `${shell.id}:input-requested:${turnId}`,
        threadTitle: shell.title,
        occurredAt: now,
      });
    }

    const previousTurn = before.latestTurn;
    const currentTurn = shell.latestTurn;
    if (
      previousTurn &&
      currentTurn &&
      previousTurn.turnId === currentTurn.turnId &&
      previousTurn.state === "running"
    ) {
      if (currentTurn.state === "completed") {
        triggers.push({
          environmentId,
          threadId: shell.id,
          kind: "turn-completed",
          dedupeKey: `${shell.id}:turn-completed:${currentTurn.turnId}:${currentTurn.completedAt ?? ""}`,
          threadTitle: shell.title,
          occurredAt: currentTurn.completedAt ?? now,
        });
      } else if (currentTurn.state === "error") {
        triggers.push({
          environmentId,
          threadId: shell.id,
          kind: "turn-failed",
          dedupeKey: `${shell.id}:turn-failed:${currentTurn.turnId}:${currentTurn.completedAt ?? ""}`,
          threadTitle: shell.title,
          occurredAt: currentTurn.completedAt ?? now,
        });
      }
      // running->interrupted is user-initiated: no notification.
    }
  }

  return triggers;
}

export interface NotificationFocusContext {
  /** Renderer-local window focus (document.hasFocus()). */
  readonly focused: boolean;
  /** Thread currently open in the UI, if any. */
  readonly activeThreadId: ThreadId | null;
}

const TOGGLE_BY_KIND: Record<
  ThreadNotificationKind,
  | "notifyOnTurnCompleted"
  | "notifyOnFailure"
  | "notifyOnApprovalRequested"
  | "notifyOnUserInputRequested"
> = {
  "turn-completed": "notifyOnTurnCompleted",
  "turn-failed": "notifyOnFailure",
  "approval-requested": "notifyOnApprovalRequested",
  "input-requested": "notifyOnUserInputRequested",
};

/**
 * Final delivery gate: per-kind toggle first, then the focus rule.
 * All toggles default OFF upstream; this function only reads them.
 */
export function shouldDeliverThreadNotification(input: {
  readonly trigger: Pick<ThreadNotificationTrigger, "kind" | "threadId">;
  readonly settings: ThreadNotificationSettings;
  readonly context: NotificationFocusContext;
}): boolean {
  const { trigger, settings, context } = input;
  if (!settings[TOGGLE_BY_KIND[trigger.kind]]) return false;
  switch (settings.notificationFocusRule) {
    case "always":
      return true;
    case "unfocused":
      return !context.focused;
    case "unfocused-or-different-thread":
      return !context.focused || context.activeThreadId !== trigger.threadId;
  }
}

/**
 * Batch shaping for the delivery adapter: at most MAX_TRIGGERS_PER_BATCH
 * individual notifications; anything larger becomes one summary with a count.
 */
export function summarizeThreadNotificationTriggers(
  triggers: ReadonlyArray<ThreadNotificationTrigger>,
): { readonly triggers: ReadonlyArray<ThreadNotificationTrigger>; readonly summaryCount: number } {
  if (triggers.length <= MAX_TRIGGERS_PER_BATCH) {
    return { triggers, summaryCount: 0 };
  }
  return { triggers: [], summaryCount: triggers.length };
}
