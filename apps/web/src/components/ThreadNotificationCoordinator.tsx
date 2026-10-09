import { shouldDeliverThreadNotification } from "@t3tools/client-runtime/state/threadNotifications";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

import { getClientSettings, useClientSettings } from "../hooks/useSettings";
import { useEnvironmentIds } from "../state/environments";
import { environmentShell } from "../state/shell";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  setNotificationBadge,
  unlockNotificationAudio,
} from "../threadNotifications";
import { resolveSidebarThreadStatus } from "./Sidebar.logic";
import { toastManager } from "./ui/toast";

interface NotificationHandle {
  readonly tag: string;
  close(): void;
}

export function ThreadNotificationCoordinator() {
  const navigate = useNavigate();
  useEffect(
    () =>
      window.desktopBridge?.onThreadNotificationActivate?.((ref) => {
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: ref.environmentId, threadId: ref.threadId },
        });
      }),
    [navigate],
  );
  const environmentIds = useEnvironmentIds();
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const pending = useRef(
    new Map<string, { environmentId: EnvironmentId; notification: NotificationHandle }>(),
  );
  const onNotification = useCallback(
    (environmentId: EnvironmentId, notification: NotificationHandle) => {
      pending.current.get(notification.tag)?.notification.close();
      pending.current.set(notification.tag, { environmentId, notification });
      setNotificationBadge(pending.current.size);
      // Register before an asynchronous native show, then reconcile its acknowledgement.
      // A superseded handle must never dismiss the replacement through close-by-tag.
      return (delivered: boolean) => {
        const current = pending.current.get(notification.tag);
        if (current !== undefined && current.notification !== notification) return false;
        if (
          delivered &&
          current !== undefined &&
          hasDesktopNotifications(getClientSettings().notificationMode)
        )
          return false;
        notification.close();
        if (current !== undefined) {
          pending.current.delete(notification.tag);
          setNotificationBadge(pending.current.size);
        }
        return !delivered && current !== undefined;
      };
    },
    [],
  );

  useEffect(() => {
    const activeIds = new Set(environmentIds);
    const count = pending.current.size;
    for (const [tag, { environmentId, notification }] of pending.current) {
      if (activeIds.has(environmentId)) continue;
      notification.close();
      pending.current.delete(tag);
    }
    if (count !== pending.current.size) setNotificationBadge(pending.current.size);
  }, [environmentIds]);

  useEffect(() => {
    const clear = () => {
      for (const { notification } of pending.current.values()) notification.close();
      pending.current.clear();
      setNotificationBadge(0);
    };
    clear();
    if (!hasDesktopNotifications(mode)) return;
    const unsubscribe = window.desktopBridge?.onNotificationBadgeClear?.(clear);
    window.addEventListener("focus", clear);
    return () => {
      unsubscribe?.();
      window.removeEventListener("focus", clear);
      clear();
    };
  }, [mode]);

  useEffect(() => {
    if (!hasNotificationSound(mode)) return;
    document.addEventListener("pointerdown", unlockNotificationAudio);
    document.addEventListener("keydown", unlockNotificationAudio);
    return () => {
      document.removeEventListener("pointerdown", unlockNotificationAudio);
      document.removeEventListener("keydown", unlockNotificationAudio);
    };
  }, [mode]);

  if (mode === "off" && !inAppNotificationsEnabled) return null;

  return environmentIds.map((environmentId) => (
    <EnvironmentNotifications
      key={environmentId}
      environmentId={environmentId}
      onNotification={onNotification}
    />
  ));
}

interface NotificationState {
  readonly raw: OrchestrationV2ThreadShell;
  readonly attention: string | null;
  readonly completion: number | null;
}

function EnvironmentNotifications({
  environmentId,
  onNotification,
}: {
  environmentId: EnvironmentId;
  onNotification: (
    environmentId: EnvironmentId,
    notification: NotificationHandle,
  ) => (delivered: boolean) => boolean;
}) {
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  // The shell reducer keeps the thread list and unchanged thread objects
  // stable, so this only rescans when a thread actually changed.
  const threads =
    shell.status === "live" && Option.isSome(shell.snapshot) ? shell.snapshot.value.threads : null;
  const mode = useClientSettings((settings) => settings.notificationMode);
  const navigate = useNavigate();
  const { environmentId: activeEnvironmentId, threadId: activeThreadId } = useParams({
    strict: false,
  });
  const currentView = useRef({ activeEnvironmentId, activeThreadId });
  useEffect(() => {
    currentView.current = { activeEnvironmentId, activeThreadId };
  }, [activeEnvironmentId, activeThreadId]);
  const previous = useRef(new Map<ThreadId, NotificationState>());

  useEffect(() => {
    if (threads === null) {
      previous.current.clear();
      return;
    }
    const next = new Map<ThreadId, NotificationState>();
    for (const rawThread of threads) {
      if (rawThread.lineage.relationshipToParent === "subagent") continue;
      const prior = previous.current.get(rawThread.id);
      // The same object cannot produce a new notification.
      if (prior?.raw === rawThread) {
        next.set(rawThread.id, prior);
        continue;
      }
      const thread = presentThreadShell(environmentId, rawThread);
      let status = resolveSidebarThreadStatus(thread);
      if (status === "ready" && thread.latestRun?.status === "failed") status = "failed";
      const attention =
        status === "input" || status === "approval" || status === "failed" || status === "limited"
          ? `${thread.latestRun?.runId ?? ""}:${status}`
          : null;
      const completedAt = Date.parse(thread.latestRun?.completedAt ?? "");
      // Commands left running (a dev server) read as ready; subagents and monitors wait.
      const completion =
        status === "ready" &&
        thread.latestRun?.status === "completed" &&
        Number.isFinite(completedAt)
          ? completedAt
          : (prior?.completion ?? null);
      next.set(thread.id, { raw: rawThread, attention, completion });
      if (
        !prior ||
        thread.archivedAt !== null ||
        effectiveSnoozed(thread, { now: new Date().toISOString() })
      )
        continue;
      const kind =
        attention && attention !== prior.attention
          ? "input"
          : completion !== null && (prior.completion === null || completion > prior.completion)
            ? "completion"
            : null;
      if (!kind) continue;
      const title =
        kind === "completion"
          ? "Thread completed"
          : status === "approval"
            ? "Approval needed"
            : status === "limited"
              ? "Usage limit reached"
              : status === "failed"
                ? "Thread failed"
                : "Input needed";
      if (hasNotificationSound(mode)) {
        void playNotificationSound(kind, () =>
          hasNotificationSound(getClientSettings().notificationMode),
        );
      }
      const canDeliverSystem =
        Boolean(window.desktopBridge?.showThreadNotification) ||
        (typeof Notification !== "undefined" && Notification.permission === "granted");
      const deliverSystem =
        canDeliverSystem &&
        hasDesktopNotifications(mode) &&
        shouldDeliverThreadNotification({
          kind:
            kind === "completion"
              ? "turn-completed"
              : status === "approval"
                ? "approval-requested"
                : status === "failed" || status === "limited"
                  ? "turn-failed"
                  : "input-requested",
          environmentId,
          threadId: thread.id,
          settings: getClientSettings(),
          focused: document.visibilityState === "visible" && document.hasFocus(),
          activeEnvironmentId,
          activeThreadId,
        });
      const showInAppNotification = () => {
        if (
          !getClientSettings().inAppNotificationsEnabled ||
          document.visibilityState !== "visible" ||
          !document.hasFocus() ||
          (currentView.current.activeEnvironmentId === environmentId &&
            currentView.current.activeThreadId === thread.id)
        )
          return;
        const toastId = toastManager.add({
          type: kind === "completion" ? "success" : status === "failed" ? "error" : "warning",
          title,
          description: thread.title,
          data: {
            hideCopyButton: true,
            leadingIcon:
              kind === "completion" ? (
                <CircleCheckIcon aria-hidden className="size-4 text-success-foreground" />
              ) : status === "approval" ? (
                <ShieldQuestionIcon aria-hidden className="size-4 text-warning-foreground" />
              ) : status === "failed" ? (
                <CircleAlertIcon aria-hidden className="size-4 text-destructive-foreground" />
              ) : (
                <MessageCircleQuestionIcon aria-hidden className="size-4 text-info-foreground" />
              ),
          },
          actionProps: {
            children: "Open thread",
            onClick: () => {
              toastManager.close(toastId);
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId, threadId: thread.id },
              });
            },
          },
        });
      };
      if (!deliverSystem) {
        showInAppNotification();
        continue;
      }
      const tag = `${environmentId}:${thread.id}`;
      if (window.desktopBridge?.showThreadNotification) {
        const close = () => {
          void window.desktopBridge?.closeThreadNotification?.(tag).catch(() => undefined);
        };
        const reconcile = onNotification(environmentId, { tag, close });
        void window.desktopBridge
          .showThreadNotification({
            title,
            body: thread.title,
            tag,
            threadRef: { environmentId, threadId: thread.id },
          })
          .then(
            (delivered) => {
              if (reconcile(delivered !== false)) showInAppNotification();
            },
            () => {
              if (reconcile(false)) showInAppNotification();
            },
          );
        continue;
      }
      try {
        const notification = new Notification(title, {
          body: thread.title,
          tag: `${environmentId}:${thread.id}`,
          silent: true,
        });
        onNotification(environmentId, notification);
        notification.addEventListener("click", () => {
          notification.close();
          window.focus();
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: thread.id },
          });
        });
      } catch {
        showInAppNotification();
      }
    }
    previous.current = next;
  }, [activeEnvironmentId, activeThreadId, environmentId, mode, navigate, onNotification, threads]);

  return null;
}
