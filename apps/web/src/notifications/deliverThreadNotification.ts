import type { ScopedThreadRef } from "@t3tools/contracts";
import type {
  ThreadNotificationKind,
  ThreadNotificationTrigger,
} from "@t3tools/client-runtime/state/threadNotifications";

import { isElectron } from "../env";
import { getActiveRouter } from "../router";

/** Body copy per trigger kind; the title is always the thread title. */
export const PRESENTATION_BY_KIND: Record<ThreadNotificationKind, string> = {
  "turn-completed": "Turn completed",
  "turn-failed": "Turn failed",
  "approval-requested": "Approval requested",
  "input-requested": "Waiting for your input",
};

export interface ThreadNotificationPresentation {
  readonly title: string;
  readonly body: string;
}

/** Navigate to a notification's thread; used by both desktop and web click paths. */
export function openThreadFromNotification(ref: ScopedThreadRef): void {
  const router = getActiveRouter();
  if (!router) return;
  void router.navigate({
    to: "/$environmentId/$threadId",
    params: { environmentId: ref.environmentId, threadId: ref.threadId },
  });
}

function webNotificationsAvailable(): boolean {
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

/**
 * Present one notification through the platform surface: Electron IPC in the
 * desktop shell, the Web Notification API in the browser (permission-gated).
 */
export function presentThreadNotification(
  trigger: ThreadNotificationTrigger,
  presentation: ThreadNotificationPresentation,
): void {
  const ref: ScopedThreadRef = { environmentId: trigger.environmentId, threadId: trigger.threadId };
  if (isElectron) {
    void window.desktopBridge?.showThreadNotification({ ...presentation, threadRef: ref });
    return;
  }
  if (!webNotificationsAvailable()) return;
  const notification = new Notification(presentation.title, {
    body: presentation.body,
    tag: trigger.dedupeKey, // OS-level dedupe across replays
  });
  notification.onclick = () => {
    window.focus();
    openThreadFromNotification(ref);
    notification.close();
  };
}

/** Collapse an oversized batch into one summary notification without deep links. */
export function summarizeThreadNotifications(count: number): void {
  if (!webNotificationsAvailable()) return;
  const notification = new Notification("Threads need your attention", {
    body: `${count} threads have updates.`,
  });
  notification.onclick = () => {
    window.focus();
    notification.close();
  };
}
