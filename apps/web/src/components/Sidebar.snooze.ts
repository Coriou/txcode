import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  spaceSnoozePresets,
  type SnoozeSpacing,
} from "@t3tools/client-runtime/state/snooze-spacing";
import {
  resolveSnoozePresets as resolveSharedSnoozePresets,
  snoozeWakeLabel,
  type SnoozePreset,
} from "@t3tools/client-runtime/state/thread-settled";

import { formatShortTimestamp, parseTimestampDate } from "../timestampFormat";

export { snoozeWakeLabel, type SnoozePreset };

function timeOfDayLabel(date: Date, timestampFormat: TimestampFormat): string {
  return formatShortTimestamp(date.toISOString(), timestampFormat);
}

function whenLabel(
  preset: SnoozePreset,
  snoozedUntil: string,
  timestampFormat: TimestampFormat,
): string {
  const wake = parseTimestampDate(snoozedUntil);
  if (wake === null) return preset.whenLabel;
  const time = timeOfDayLabel(wake, timestampFormat);
  return preset.id === "next-week"
    ? `${wake.toLocaleDateString(undefined, { weekday: "short" })} ${time}`
    : time;
}

export function resolveSnoozePresets(
  now: Date,
  timestampFormat: TimestampFormat,
  spacing?: SnoozeSpacing,
): ReadonlyArray<SnoozePreset> {
  const presets = resolveSharedSnoozePresets(now);
  const spaced =
    spacing === undefined
      ? presets
      : spaceSnoozePresets(presets, {
          occupied: spacing.occupied,
          spacingMinutes: spacing.spacingMinutes,
          formatWhenLabel: (preset, snoozedUntil) =>
            whenLabel(preset, snoozedUntil, timestampFormat),
        });
  return spaced.map((preset) => {
    const label = whenLabel(preset, preset.snoozedUntil, timestampFormat);
    return label === preset.whenLabel ? preset : { ...preset, whenLabel: label };
  });
}
