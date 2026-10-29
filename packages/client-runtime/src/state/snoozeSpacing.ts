// @effect-diagnostics globalDate:off -- Slot allocation works in epoch milliseconds.
// Fork-local: spread snoozes that would otherwise wake together; upstream has no equivalent.
import { effectiveSnoozed, type SnoozePreset, type ThreadSnoozeShell } from "./threadSettled.ts";

/** A crowded preset still wakes within the hour; past that, colliding snoozes share the last slot. */
const MAX_SNOOZE_SPACING_OFFSET_MS = 60 * 60 * 1_000;

const MINUTE_MS = 60 * 1_000;

/** Wake time (epoch ms) to the number of threads still holding it. */
export type SnoozeOccupancy = ReadonlyMap<number, number>;

export interface SnoozeSpacing {
  readonly occupied: SnoozeOccupancy;
  readonly spacingMinutes: number;
}

export interface SnoozeOccupantShell extends ThreadSnoozeShell {
  readonly archivedAt?: string | null;
}

const NO_OCCUPANTS: SnoozeOccupancy = new Map();

/** One future wake time per reservation. Archived, expired, and early-woken threads are absent. */
export function snoozeReservationKey<T extends SnoozeOccupantShell>(
  shells: ReadonlyArray<T>,
  options: { readonly now: string },
): string {
  const stamps: string[] = [];
  for (const shell of shells) {
    if (shell.archivedAt != null) continue;
    if (!effectiveSnoozed(shell, options) || shell.snoozedUntil == null) continue;
    stamps.push(shell.snoozedUntil);
  }
  stamps.sort();
  return stamps.join("\n");
}

/** Occupancy for `snoozeReservationKey`. Duplicate stamps keep their counts. */
export function snoozeOccupancyFromReservationKey(reservationKey: string): SnoozeOccupancy {
  if (reservationKey.length === 0) return NO_OCCUPANTS;
  const occupancy = new Map<number, number>();
  for (const stamp of reservationKey.split("\n")) {
    const wakeAtMs = Date.parse(stamp);
    if (Number.isNaN(wakeAtMs)) continue;
    occupancy.set(wakeAtMs, (occupancy.get(wakeAtMs) ?? 0) + 1);
  }
  return occupancy;
}

function formatSnoozeWhenLabel(preset: SnoozePreset, snoozedUntil: string): string {
  const wake = new Date(snoozedUntil);
  const time = wake.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  // "Next week" does not name its day; every other preset label already does, or is a duration.
  if (preset.label !== "Next week") return time;
  return `${wake.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

/**
 * Only a snooze that will still wake on its own reserves a slot: an expired timer or a
 * thread already woken by approval, input or failure is back and must not push others later.
 */
export function selectSnoozeOccupancy<T extends SnoozeOccupantShell>(
  shells: ReadonlyArray<T>,
  options: { readonly now: string; readonly exclude?: (shell: T) => boolean },
): SnoozeOccupancy {
  const occupancy = new Map<number, number>();
  for (const shell of shells) {
    if (shell.archivedAt != null) continue;
    if (options.exclude?.(shell) === true) continue;
    if (!effectiveSnoozed(shell, options)) continue;
    if (shell.snoozedUntil == null) continue;
    const wakeAtMs = Date.parse(shell.snoozedUntil);
    if (Number.isNaN(wakeAtMs)) continue;
    occupancy.set(wakeAtMs, (occupancy.get(wakeAtMs) ?? 0) + 1);
  }
  return occupancy;
}

/** Frees one reservation, so a thread being re-snoozed keeps its slot and keeps others' counts. */
export function withoutSnoozeOccupant(
  occupancy: SnoozeOccupancy,
  snoozedUntil: string | null | undefined,
): SnoozeOccupancy {
  if (snoozedUntil == null) return occupancy;
  const wakeAtMs = Date.parse(snoozedUntil);
  const count = Number.isNaN(wakeAtMs) ? 0 : (occupancy.get(wakeAtMs) ?? 0);
  if (count === 0) return occupancy;
  const next = new Map(occupancy);
  if (count === 1) next.delete(wakeAtMs);
  else next.set(wakeAtMs, count - 1);
  return next;
}

/** `occupied` is not mutated; callers keep reporting the same reservations. */
export function allocateSnoozeSlot(input: {
  readonly snoozedUntil: string;
  readonly occupied: SnoozeOccupancy;
  readonly spacingMinutes: number;
}): string {
  const baseMs = Date.parse(input.snoozedUntil);
  const stepMs = input.spacingMinutes * MINUTE_MS;
  if (Number.isNaN(baseMs) || stepMs <= 0) return input.snoozedUntil;
  let offsetMs = 0;
  while (
    offsetMs < MAX_SNOOZE_SPACING_OFFSET_MS &&
    (input.occupied.get(baseMs + offsetMs) ?? 0) > 0
  ) {
    offsetMs = Math.min(offsetMs + stepMs, MAX_SNOOZE_SPACING_OFFSET_MS);
  }
  if (offsetMs === 0) return input.snoozedUntil;
  return new Date(baseMs + offsetMs).toISOString();
}

/**
 * One batch snoozes in selection order, so threads selected together claim consecutive
 * slots even though every command is dispatched before any of them lands.
 */
export function allocateSnoozeSlots(input: {
  readonly snoozedUntil: string;
  readonly count: number;
  readonly occupied: SnoozeOccupancy;
  readonly spacingMinutes: number;
}): ReadonlyArray<string> {
  const claimed = new Map(input.occupied);
  const slots: string[] = [];
  for (let index = 0; index < input.count; index += 1) {
    const slot = allocateSnoozeSlot({
      snoozedUntil: input.snoozedUntil,
      occupied: claimed,
      spacingMinutes: input.spacingMinutes,
    });
    const slotMs = Date.parse(slot);
    claimed.set(slotMs, (claimed.get(slotMs) ?? 0) + 1);
    slots.push(slot);
  }
  return slots;
}

export function spaceSnoozePresets(
  presets: ReadonlyArray<SnoozePreset>,
  options: {
    readonly occupied?: SnoozeOccupancy;
    readonly spacingMinutes: number;
    readonly formatWhenLabel?: (preset: SnoozePreset, snoozedUntil: string) => string;
  },
): ReadonlyArray<SnoozePreset> {
  if (options.spacingMinutes <= 0) return presets;
  const occupied = options.occupied ?? NO_OCCUPANTS;
  const formatWhenLabel = options.formatWhenLabel ?? formatSnoozeWhenLabel;
  return presets.map((preset) => {
    const snoozedUntil = allocateSnoozeSlot({
      snoozedUntil: preset.snoozedUntil,
      occupied,
      spacingMinutes: options.spacingMinutes,
    });
    if (snoozedUntil === preset.snoozedUntil) return preset;
    return { ...preset, snoozedUntil, whenLabel: formatWhenLabel(preset, snoozedUntil) };
  });
}
