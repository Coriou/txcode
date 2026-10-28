// @effect-diagnostics globalDate:off -- Slot allocation and DST cases use local calendar boundaries.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  allocateSnoozeSlot,
  allocateSnoozeSlots,
  selectSnoozeOccupancy,
  snoozeOccupancyFromReservationKey,
  snoozeReservationKey,
  spaceSnoozePresets,
  withoutSnoozeOccupant,
  type SnoozeOccupancy,
  type SnoozeOccupantShell,
} from "./snoozeSpacing.ts";
import { resolveSnoozePresets } from "./threadSettled.ts";

const NOW = "2026-04-10T12:00:00.000Z";
const TOMORROW = "2026-04-11T09:00:00.000Z";
const MINUTE_MS = 60_000;

afterEach(() => vi.unstubAllEnvs());

function plusMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * MINUTE_MS).toISOString();
}

function occupancy(...wakeTimes: readonly string[]): SnoozeOccupancy {
  const counts = new Map<number, number>();
  for (const wakeTime of wakeTimes) {
    const wakeAtMs = Date.parse(wakeTime);
    counts.set(wakeAtMs, (counts.get(wakeAtMs) ?? 0) + 1);
  }
  return counts;
}

function makeShell(
  input: {
    readonly snoozedUntil?: string | null;
    readonly archivedAt?: string | null;
    readonly pending?: "approval" | "user-input";
    readonly environmentId?: string;
  } = {},
): SnoozeOccupantShell & { readonly environmentId: string } {
  return {
    environmentId: input.environmentId ?? "environment-1",
    snoozedUntil: input.snoozedUntil ?? null,
    snoozedAt: input.snoozedUntil == null ? null : "2026-04-10T08:00:00.000Z",
    archivedAt: input.archivedAt ?? null,
    hasPendingApprovals: input.pending === "approval",
    hasPendingUserInput: input.pending === "user-input",
    latestUserMessageAt: null,
    latestTurn: null,
    session: null,
  };
}

describe("allocateSnoozeSlot", () => {
  it("keeps the base time when nothing occupies it", () => {
    expect(
      allocateSnoozeSlot({ snoozedUntil: TOMORROW, occupied: occupancy(), spacingMinutes: 5 }),
    ).toBe(TOMORROW);
  });

  it("walks past every occupied slot in five-minute steps", () => {
    expect(
      allocateSnoozeSlot({
        snoozedUntil: TOMORROW,
        occupied: occupancy(TOMORROW, plusMinutes(TOMORROW, 5)),
        spacingMinutes: 5,
      }),
    ).toBe(plusMinutes(TOMORROW, 10));
  });

  it("skips occupied slots that are not on the step grid", () => {
    expect(
      allocateSnoozeSlot({
        snoozedUntil: TOMORROW,
        occupied: occupancy(plusMinutes(TOMORROW, 2)),
        spacingMinutes: 5,
      }),
    ).toBe(TOMORROW);
  });

  it("shares the last slot past the one-hour cap", () => {
    const wakeTimes = Array.from({ length: 13 }, (_, index) => plusMinutes(TOMORROW, index * 5));
    expect(
      allocateSnoozeSlot({
        snoozedUntil: TOMORROW,
        occupied: occupancy(...wakeTimes),
        spacingMinutes: 5,
      }),
    ).toBe(plusMinutes(TOMORROW, 60));
  });

  it("caps an uneven step on the hour instead of overshooting", () => {
    const wakeTimes = Array.from({ length: 9 }, (_, index) => plusMinutes(TOMORROW, index * 7));
    expect(
      allocateSnoozeSlot({
        snoozedUntil: TOMORROW,
        occupied: occupancy(...wakeTimes),
        spacingMinutes: 7,
      }),
    ).toBe(plusMinutes(TOMORROW, 60));
  });

  it("is an identity allocator when spacing is disabled", () => {
    expect(
      allocateSnoozeSlot({
        snoozedUntil: TOMORROW,
        occupied: occupancy(TOMORROW),
        spacingMinutes: 0,
      }),
    ).toBe(TOMORROW);
  });

  it("returns malformed timestamps untouched", () => {
    expect(
      allocateSnoozeSlot({
        snoozedUntil: "not-a-date",
        occupied: occupancy(TOMORROW),
        spacingMinutes: 5,
      }),
    ).toBe("not-a-date");
  });
});

describe("allocateSnoozeSlots", () => {
  it("claims consecutive slots in selection order", () => {
    expect(
      allocateSnoozeSlots({
        snoozedUntil: TOMORROW,
        count: 3,
        occupied: occupancy(),
        spacingMinutes: 5,
      }),
    ).toEqual([TOMORROW, plusMinutes(TOMORROW, 5), plusMinutes(TOMORROW, 10)]);
  });

  it("starts after slots that were already taken", () => {
    expect(
      allocateSnoozeSlots({
        snoozedUntil: TOMORROW,
        count: 2,
        occupied: occupancy(TOMORROW),
        spacingMinutes: 5,
      }),
    ).toEqual([plusMinutes(TOMORROW, 5), plusMinutes(TOMORROW, 10)]);
  });

  it("does not mutate the occupancy it is given", () => {
    const occupied = occupancy(TOMORROW);
    allocateSnoozeSlots({ snoozedUntil: TOMORROW, count: 2, occupied, spacingMinutes: 5 });
    expect([...occupied.keys()]).toEqual([Date.parse(TOMORROW)]);
  });

  it("holds a long batch to the hour cap counted from its base", () => {
    const slots = allocateSnoozeSlots({
      snoozedUntil: TOMORROW,
      count: 20,
      occupied: occupancy(),
      spacingMinutes: 5,
    });
    expect(slots[0]).toBe(TOMORROW);
    expect(slots[12]).toBe(plusMinutes(TOMORROW, 60));
    expect(slots[19]).toBe(plusMinutes(TOMORROW, 60));
  });

  it("keeps the base time for every thread when spacing is disabled", () => {
    expect(
      allocateSnoozeSlots({
        snoozedUntil: TOMORROW,
        count: 2,
        occupied: occupancy(TOMORROW),
        spacingMinutes: 0,
      }),
    ).toEqual([TOMORROW, TOMORROW]);
  });
});

describe("selectSnoozeOccupancy", () => {
  it("counts future snoozes across environments", () => {
    expect([
      ...selectSnoozeOccupancy(
        [
          makeShell({ snoozedUntil: TOMORROW, environmentId: "environment-1" }),
          makeShell({ snoozedUntil: TOMORROW, environmentId: "environment-2" }),
          makeShell({ snoozedUntil: plusMinutes(TOMORROW, 5), environmentId: "environment-2" }),
        ],
        { now: NOW },
      ),
    ]).toEqual([
      [Date.parse(TOMORROW), 2],
      [Date.parse(plusMinutes(TOMORROW, 5)), 1],
    ]);
  });

  it("ignores expired snoozes", () => {
    const counts = selectSnoozeOccupancy(
      [makeShell({ snoozedUntil: "2026-04-10T10:00:00.000Z" })],
      {
        now: NOW,
      },
    );
    expect(counts.size).toBe(0);
  });

  it("frees the slot when the thread is already back", () => {
    const counts = selectSnoozeOccupancy(
      [makeShell({ snoozedUntil: TOMORROW, pending: "approval" })],
      { now: NOW },
    );
    expect(counts.size).toBe(0);
  });

  it("ignores archived threads", () => {
    const counts = selectSnoozeOccupancy(
      [makeShell({ snoozedUntil: TOMORROW, archivedAt: "2026-04-10T09:00:00.000Z" })],
      { now: NOW },
    );
    expect(counts.size).toBe(0);
  });

  it("excludes the threads being snoozed", () => {
    const self = makeShell({ snoozedUntil: TOMORROW });
    const counts = selectSnoozeOccupancy([self], {
      now: NOW,
      exclude: (shell) => shell === self,
    });
    expect(counts.size).toBe(0);
  });

  it("ignores malformed wake data", () => {
    const counts = selectSnoozeOccupancy([makeShell({ snoozedUntil: "not-a-date" })], {
      now: NOW,
    });
    expect(counts.size).toBe(0);
  });

  it("rebuilds the same counts from the canonical reservation key", () => {
    const shells = [
      makeShell({ snoozedUntil: TOMORROW }),
      makeShell({ snoozedUntil: TOMORROW }),
      makeShell({ snoozedUntil: plusMinutes(TOMORROW, 5) }),
      makeShell({ snoozedUntil: TOMORROW, archivedAt: "2026-04-10T09:00:00.000Z" }),
      makeShell({ snoozedUntil: "not-a-date" }),
      makeShell({ snoozedUntil: TOMORROW, pending: "approval" }),
    ];
    const key = snoozeReservationKey(shells, { now: NOW });
    expect(snoozeOccupancyFromReservationKey(key)).toEqual(
      selectSnoozeOccupancy(shells, { now: NOW }),
    );
  });
});

describe("withoutSnoozeOccupant", () => {
  it("drops one reservation and keeps the others at the same time", () => {
    const counts = occupancy(TOMORROW, TOMORROW);
    expect([...withoutSnoozeOccupant(counts, TOMORROW)]).toEqual([[Date.parse(TOMORROW), 1]]);
  });

  it("removes the entry when it was the last reservation", () => {
    expect(withoutSnoozeOccupant(occupancy(TOMORROW), TOMORROW).size).toBe(0);
  });

  it("returns the same occupancy for a thread with no snooze", () => {
    const counts = occupancy(TOMORROW);
    expect(withoutSnoozeOccupant(counts, null)).toBe(counts);
  });
});

describe("spaceSnoozePresets", () => {
  const presets = resolveSnoozePresets(new Date(NOW));
  const tomorrowUntil = presets.find((preset) => preset.id === "tomorrow")!.snoozedUntil;

  it("returns the resolver's presets untouched when spacing is disabled", () => {
    expect(spaceSnoozePresets(presets, { spacingMinutes: 0 })).toBe(presets);
  });

  it("shifts only the preset whose base time is occupied", () => {
    const shifted = spaceSnoozePresets(presets, {
      spacingMinutes: 5,
      occupied: occupancy(tomorrowUntil),
    });
    expect(shifted.find((preset) => preset.id === "tomorrow")?.snoozedUntil).toBe(
      plusMinutes(tomorrowUntil, 5),
    );
    expect(shifted.find((preset) => preset.id === "hour")).toEqual(
      presets.find((preset) => preset.id === "hour"),
    );
  });

  it("labels the shifted time through the callback", () => {
    const shifted = spaceSnoozePresets(presets, {
      spacingMinutes: 5,
      occupied: occupancy(tomorrowUntil),
      formatWhenLabel: (_preset, snoozedUntil) => `shifted ${snoozedUntil}`,
    });
    expect(shifted.find((preset) => preset.id === "tomorrow")?.whenLabel).toBe(
      `shifted ${plusMinutes(tomorrowUntil, 5)}`,
    );
  });

  it("keeps the resolver's wording by default", () => {
    const shifted = spaceSnoozePresets(presets, {
      spacingMinutes: 5,
      occupied: occupancy(tomorrowUntil),
    });
    expect(shifted.find((preset) => preset.id === "tomorrow")?.whenLabel).toBe(
      new Date(plusMinutes(tomorrowUntil, 5)).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }),
    );
  });

  it("staggers a next-day preset across a daylight-saving boundary", () => {
    vi.stubEnv("TZ", "Europe/Berlin");
    const now = new Date(2026, 2, 28, 12, 0);
    const dstPresets = resolveSnoozePresets(now);
    const tomorrow = dstPresets.find((preset) => preset.id === "tomorrow")!;
    const shifted = spaceSnoozePresets(dstPresets, {
      spacingMinutes: 5,
      occupied: occupancy(tomorrow.snoozedUntil),
    }).find((preset) => preset.id === "tomorrow")!;
    const shiftedDate = new Date(shifted.snoozedUntil);
    expect(shiftedDate.getDate()).toBe(29);
    expect(shiftedDate.getHours()).toBe(9);
    expect(shiftedDate.getMinutes()).toBe(5);
  });
});
