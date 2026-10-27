// @effect-diagnostics globalDate:off -- Presets are local calendar times.
import { describe, expect, it } from "vite-plus/test";

import { formatShortTimestamp } from "../timestampFormat";
import { resolveSnoozePresets } from "./Sidebar.snooze";

const now = new Date(2026, 4, 8, 10, 0);
const tomorrow = resolveSnoozePresets(now, "24-hour").find((preset) => preset.id === "tomorrow")!;
const MINUTE_MS = 60_000;

describe("resolveSnoozePresets", () => {
  it("formats every preset with the user's timestamp format", () => {
    for (const preset of resolveSnoozePresets(now, "24-hour")) {
      expect(preset.whenLabel.endsWith(formatShortTimestamp(preset.snoozedUntil, "24-hour"))).toBe(
        true,
      );
    }
  });

  it("labels the staggered slot instead of the base time", () => {
    const spaced = resolveSnoozePresets(now, "24-hour", {
      occupied: new Map([[Date.parse(tomorrow.snoozedUntil), 1]]),
      spacingMinutes: 5,
    });
    const shifted = spaced.find((preset) => preset.id === "tomorrow")!;

    expect(Date.parse(shifted.snoozedUntil)).toBe(
      Date.parse(tomorrow.snoozedUntil) + 5 * MINUTE_MS,
    );
    expect(shifted.whenLabel).toBe(formatShortTimestamp(shifted.snoozedUntil, "24-hour"));
  });

  it("keeps the base time when spacing is off", () => {
    const spaced = resolveSnoozePresets(now, "24-hour", {
      occupied: new Map([[Date.parse(tomorrow.snoozedUntil), 1]]),
      spacingMinutes: 0,
    });
    expect(spaced.find((preset) => preset.id === "tomorrow")?.snoozedUntil).toBe(
      tomorrow.snoozedUntil,
    );
  });
});
