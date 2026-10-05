import type { ClientSettings, EnvironmentId, ThreadId } from "@t3tools/contracts";

export type ThreadNotificationKind =
  | "turn-completed"
  | "turn-failed"
  | "approval-requested"
  | "input-requested";
export type ThreadNotificationSettings = Pick<
  ClientSettings,
  | "notifyOnTurnCompleted"
  | "notifyOnFailure"
  | "notifyOnApprovalRequested"
  | "notifyOnUserInputRequested"
  | "notificationFocusRule"
  | "notificationForegroundKinds"
>;
const preferenceByKind = {
  "turn-completed": "notifyOnTurnCompleted",
  "turn-failed": "notifyOnFailure",
  "approval-requested": "notifyOnApprovalRequested",
  "input-requested": "notifyOnUserInputRequested",
} as const;

// Fork-local delivery policy. Upstream's V2 coordinator owns detection, replay baselines and tags.
export function shouldDeliverThreadNotification(input: {
  kind: ThreadNotificationKind;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  settings: ThreadNotificationSettings;
  focused: boolean;
  activeEnvironmentId?: string | undefined;
  activeThreadId?: string | undefined;
}): boolean {
  if (!input.settings[preferenceByKind[input.kind]]) return false;
  if (!input.focused) return true;
  if (
    input.settings.notificationForegroundKinds !== null &&
    !input.settings.notificationForegroundKinds.includes(input.kind)
  )
    return false;
  if (input.settings.notificationFocusRule === "always") return true;
  if (input.settings.notificationFocusRule === "unfocused") return false;
  return (
    input.activeEnvironmentId !== input.environmentId || input.activeThreadId !== input.threadId
  );
}
