import { Switch } from "../ui/switch";
import type { NotificationFocusRule } from "@t3tools/contracts";
import { useState } from "react";

import {
  hasDesktopNotifications,
  hasNotificationSound,
  NOTIFICATION_MODE_LABELS,
  unlockNotificationAudio,
} from "../../threadNotifications";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function NotificationSettings() {
  const settings = useScopedSettings();
  const mode = settings.notificationMode;
  const updateSettings = useUpdateScopedSettings();
  const [permissionMessage, setPermissionMessage] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);

  return (
    <>
      <SettingsRow
        {...searchableSetting("thread-notifications")}
        description={
          permissionMessage ??
          "System alerts when a thread finishes, fails, or needs input or approval. Applies to this device while Tx Code is open."
        }
        control={
          <Select
            value={mode}
            disabled={requesting}
            onValueChange={async (value) => {
              if (
                value !== "off" &&
                value !== "notifications" &&
                value !== "sound" &&
                value !== "notifications-and-sound"
              )
                return;
              setPermissionMessage(null);
              if (hasNotificationSound(value)) unlockNotificationAudio();
              if (hasDesktopNotifications(value)) {
                if (typeof Notification === "undefined" || !window.isSecureContext) {
                  setPermissionMessage(
                    "Notifications need a supported browser over HTTPS, or the desktop app. Sound only is still available.",
                  );
                  return;
                }
                setRequesting(true);
                try {
                  const permission = await Notification.requestPermission();
                  if (permission !== "granted") {
                    setPermissionMessage(
                      "Allow notifications in your browser or system settings, then choose this option again. Sound only is still available.",
                    );
                    return;
                  }
                } catch {
                  setPermissionMessage(
                    "Notifications are unavailable in this browser. Sound only is still available.",
                  );
                  return;
                } finally {
                  setRequesting(false);
                }
              }
              updateSettings({ notificationMode: value });
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Thread notifications">
              <SelectValue>{NOTIFICATION_MODE_LABELS[mode]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {Object.entries(NOTIFICATION_MODE_LABELS).map(([value, label]) => (
                <SelectItem key={value} hideIndicator value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {(
        [
          ["notifyOnTurnCompleted", "Completion alerts", "notify-turn-completed"],
          ["notifyOnFailure", "Failure alerts", "notify-failures"],
          ["notifyOnApprovalRequested", "Approval alerts", "notify-approval-requests"],
          ["notifyOnUserInputRequested", "Input alerts", "notify-input-requests"],
        ] as const
      ).map(([key, label, id]) => (
        <SettingsRow
          key={key}
          {...searchableSetting(id)}
          title={label}
          description="Choose which events show system notifications."
          control={
            <Switch
              checked={settings[key]}
              onCheckedChange={(checked) =>
                updateSettings({ [key]: checked, notificationForegroundKinds: null })
              }
              aria-label={label}
            />
          }
        />
      ))}
      <SettingsRow
        {...searchableSetting("notification-focus-rule")}
        title="Alert focus"
        description="When system notifications can appear."
        control={
          <Select
            value={settings.notificationFocusRule}
            onValueChange={(value) => {
              if (
                value === "always" ||
                value === "unfocused" ||
                value === "unfocused-or-different-thread"
              )
                updateSettings({ notificationFocusRule: value, notificationForegroundKinds: null });
            }}
          >
            <SelectTrigger size="sm" aria-label="Alert focus">
              <SelectValue>
                {
                  (
                    {
                      always: "Always",
                      unfocused: "When unfocused",
                      "unfocused-or-different-thread": "When unfocused or viewing another thread",
                    } satisfies Record<NotificationFocusRule, string>
                  )[settings.notificationFocusRule]
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {Object.entries({
                always: "Always",
                unfocused: "When unfocused",
                "unfocused-or-different-thread": "When unfocused or viewing another thread",
              }).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </>
  );
}
