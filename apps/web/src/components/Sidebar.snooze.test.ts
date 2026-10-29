// @effect-diagnostics globalDate:off -- Presets are local calendar times.
import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatShortTimestamp } from "../timestampFormat";
import { resolveSnoozePresets } from "./Sidebar.snooze";

const now = new Date(2026, 4, 8, 10, 0);
const environmentId = "environment-1" as EnvironmentId;
const TOMORROW_ID = "at:tomorrow:09:00";
const tomorrow = resolveSnoozePresets(now, "24-hour", environmentId).find(
  (preset) => preset.id === TOMORROW_ID,
)!;
const MINUTE_MS = 60_000;

describe("resolveSnoozePresets", () => {
  it("formats every preset with the user's timestamp format", () => {
    for (const preset of resolveSnoozePresets(now, "24-hour", environmentId)) {
      expect(preset.whenLabel.endsWith(formatShortTimestamp(preset.snoozedUntil, "24-hour"))).toBe(
        true,
      );
    }
  });

  it("labels the staggered slot instead of the base time", () => {
    const spaced = resolveSnoozePresets(now, "24-hour", environmentId, {
      occupied: new Map([[Date.parse(tomorrow.snoozedUntil), 1]]),
      spacingMinutes: 5,
    });
    const shifted = spaced.find((preset) => preset.id === TOMORROW_ID)!;

    expect(Date.parse(shifted.snoozedUntil)).toBe(
      Date.parse(tomorrow.snoozedUntil) + 5 * MINUTE_MS,
    );
    expect(shifted.whenLabel).toBe(formatShortTimestamp(shifted.snoozedUntil, "24-hour"));
  });

  it("keeps the base time when spacing is off", () => {
    const spaced = resolveSnoozePresets(now, "24-hour", environmentId, {
      occupied: new Map([[Date.parse(tomorrow.snoozedUntil), 1]]),
      spacingMinutes: 0,
    });
    expect(spaced.find((preset) => preset.id === TOMORROW_ID)?.snoozedUntil).toBe(
      tomorrow.snoozedUntil,
    );
  });
});
