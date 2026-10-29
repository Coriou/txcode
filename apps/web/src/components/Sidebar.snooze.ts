import type { EnvironmentId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
// Fork-local: presets come back spaced, each carrying its own wake time.
import {
  spaceSnoozePresets,
  type SnoozeSpacing,
} from "@t3tools/client-runtime/state/snooze-spacing";
import {
  pickSnoozePreset as pickSharedSnoozePreset,
  resolveSnoozePresets as resolveSharedSnoozePresets,
  snoozeWakeLabel,
  type SnoozePreset,
} from "@t3tools/client-runtime/state/thread-settled";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "../state/server";
import { formatShortTimestamp } from "../timestampFormat";
import { toastManager } from "./ui/toast";

export { snoozeWakeLabel, type SnoozePreset };

/** The snooze menu for a thread, from its environment's presets, read when the menu opens. */
export function resolveSnoozePresets(
  now: Date,
  timestampFormat: TimestampFormat,
  environmentId: EnvironmentId,
  spacing?: SnoozeSpacing,
): ReadonlyArray<SnoozePreset> {
  const options = snoozeOptions(timestampFormat, environmentId);
  const presets = resolveSharedSnoozePresets(now, options);
  if (spacing === undefined) return presets;
  return spaceSnoozePresets(presets, {
    occupied: spacing.occupied,
    spacingMinutes: spacing.spacingMinutes,
    formatWhenLabel: (preset, snoozedUntil) => {
      const wake = new Date(snoozedUntil);
      return Number.isNaN(wake.getTime()) ? preset.whenLabel : options.formatTime(wake);
    },
  });
}

/** A shown menu choice as picked; see the shared `pickSnoozePreset`. */
export function pickSnoozePreset(
  shown: ReadonlyArray<SnoozePreset>,
  id: string,
  timestampFormat: TimestampFormat,
  environmentId: EnvironmentId,
): SnoozePreset | undefined {
  const picked = pickSharedSnoozePreset({
    shown,
    id,
    now: new Date(),
    ...snoozeOptions(timestampFormat, environmentId),
  });
  if (!picked) {
    toastManager.add({
      type: "warning",
      title: "Could not snooze thread",
      description: "That snooze time has passed. Choose another time.",
    });
  }
  return picked;
}

function snoozeOptions(timestampFormat: TimestampFormat, environmentId: EnvironmentId) {
  const presets = appAtomRegistry.get(
    serverEnvironment.settingsValueAtom(environmentId),
  )?.snoozePresets;
  return {
    ...(presets ? { presets } : {}),
    formatTime: (date: Date) => formatShortTimestamp(date.toISOString(), timestampFormat),
  };
}
