import { shouldDeliverThreadNotification } from "@t3tools/client-runtime/state/threadNotifications";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import {
  type EnvironmentThreadShell,
  type PendingSubagentRequest,
  presentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { pendingSubagentRequestsByThread } from "@t3tools/client-runtime/state/threads";
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
import { useEffect, useEffectEvent, useRef } from "react";

import { getClientSettings, useClientSettings } from "../hooks/useSettings";
import { useEnvironmentIds } from "../state/environments";
import { environmentShell } from "../state/shell";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  setNotificationBadge,
  threadNotificationTag,
  unlockNotificationAudio,
} from "../threadNotifications";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "./Sidebar.logic";
import {
  createThreadNotificationGate,
  type ThreadNotificationKind,
  type ThreadNotificationObservation,
} from "./ThreadNotificationCoordinator.logic";
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
  const onNotification = (environmentId: EnvironmentId, notification: NotificationHandle) => {
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
  };

  useEffect(() => {
    const activeIds = new Set(environmentIds);
    const count = pending.current.size;
    for (const [tag, entry] of pending.current) {
      if (activeIds.has(entry.environmentId)) continue;
      entry.notification.close();
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

interface NotificationState extends ThreadNotificationObservation {
  readonly raw: OrchestrationV2ThreadShell;
  readonly subagentRequest: PendingSubagentRequest | null;
  readonly thread: EnvironmentThreadShell;
  readonly status: SidebarThreadStatus;
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

  // Completions fire from a timer, so read settings, focus and route when presenting.
  const present = useEffectEvent((threadId: ThreadId, kind: ThreadNotificationKind) => {
    const entry = previous.current.get(threadId);
    if (!entry) return;
    const { thread, status } = entry;
    if (effectiveSnoozed(thread, { now: new Date().toISOString() })) return;
    const title =
      kind === "completion"
        ? "Thread completed"
        : status === "approval"
          ? "Approval needed"
          : status === "limited"
            ? "Usage limit reached"
            : status === "failed"
              ? "Thread failed"
              : status === "request"
                ? "Guest request"
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
      return;
    }
    const tag = threadNotificationTag(environmentId, thread.id);
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
      return;
    }
    try {
      const notification = new Notification(title, {
        body: thread.title,
        tag,
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
  });
  const gate = useRef<ReturnType<typeof createThreadNotificationGate<ThreadId>>>(null);
  useEffect(() => {
    const created = createThreadNotificationGate<ThreadId>((threadId, kind) =>
      present(threadId, kind),
    );
    gate.current = created;
    return () => {
      created.clear();
      gate.current = null;
      // A new gate has no pending completions, so forget the states they compared against.
      previous.current.clear();
    };
  }, []);

  useEffect(() => {
    const pendingCompletions = gate.current;
    if (!pendingCompletions) return;
    if (threads === null) {
      pendingCompletions.clear();
      previous.current.clear();
      return;
    }
    const next = new Map<ThreadId, NotificationState>();
    const subagentRequests = pendingSubagentRequestsByThread(threads);
    const changed: Array<[NotificationState | undefined, NotificationState]> = [];
    for (const rawThread of threads) {
      if (rawThread.lineage.relationshipToParent === "subagent") continue;
      const prior = previous.current.get(rawThread.id);
      const subagentRequest = subagentRequests.get(rawThread.id) ?? null;
      if (prior?.raw === rawThread && prior.subagentRequest === subagentRequest) {
        next.set(rawThread.id, prior);
        continue;
      }
      const thread = presentThreadShell(environmentId, rawThread, subagentRequest);
      let status = resolveSidebarThreadStatus(thread);
      if (status === "ready" && thread.latestRun?.status === "failed") status = "failed";
      const attention =
        status === "input" ||
        status === "request" ||
        status === "approval" ||
        status === "failed" ||
        status === "limited"
          ? `${thread.latestRun?.runId ?? ""}:${status}`
          : null;
      const completedAt = Date.parse(thread.latestRun?.completedAt ?? "");
      const settled = status === "ready" && thread.latestRun?.status === "completed";
      const state = {
        raw: rawThread,
        subagentRequest,
        thread,
        status,
        attention,
        settled,
        completedAt: settled && Number.isFinite(completedAt) ? completedAt : null,
      };
      next.set(thread.id, state);
      changed.push([prior, state]);
    }
    previous.current = next;
    pendingCompletions.retain(new Set(next.keys()));
    for (const [prior, state] of changed) {
      pendingCompletions.observe(state.thread.id, prior, state, {
        archived: state.thread.archivedAt !== null,
        quiet: state.raw.latestRunStopRequested === true || state.raw.latestRunSilent === true,
      });
    }
  }, [environmentId, threads]);

  return null;
}
