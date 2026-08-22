import type { EnvironmentId, OrchestrationShellSnapshot } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import type {
  ThreadNotificationSettings,
  ThreadNotificationTrigger,
} from "@t3tools/client-runtime/state/threadNotifications";
import type { EnvironmentCatalogState } from "@t3tools/client-runtime/state/connections";
import {
  diffThreadNotificationTriggers,
  shouldDeliverThreadNotification,
  summarizeThreadNotificationTriggers,
  THROTTLE_MS,
} from "@t3tools/client-runtime/state/threadNotifications";

import { environmentCatalog } from "../connection/catalog";
import { getClientSettings } from "../hooks/useSettings";
import { environmentSnapshotAtom } from "../state/shell";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { getActiveThreadRoute } from "./activeThreadRoute";
import {
  PRESENTATION_BY_KIND,
  presentThreadNotification,
  summarizeThreadNotifications,
} from "./deliverThreadNotification";

/** How long a shown dedupeKey stays remembered before pruning. */
const SHOWN_KEY_TTL_MS = 5 * THROTTLE_MS;

export interface ObserverDeps {
  readonly registry?: AtomRegistry.AtomRegistry;
  /** Value atom exposing the environment catalog; defaults to the app catalog. */
  readonly catalogValueAtom?: Atom.Atom<EnvironmentCatalogState>;
  readonly snapshotAtom?: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationShellSnapshot | null>;
  readonly readSettings?: () => ThreadNotificationSettings;
  /**
   * Presentation-only sink; the observer owns all bookkeeping (dedupe keys,
   * throttle stamp) BEFORE calling this, so injected sinks cannot desync state.
   */
  readonly deliver?: (
    triggers: ReadonlyArray<ThreadNotificationTrigger>,
    summaryCount: number,
  ) => void;
  readonly focused?: () => boolean;
  /** ISO wall clock; its epoch also drives dedupe TTL and throttle math. */
  readonly now?: () => string;
}

interface EnvironmentSubscriptionState {
  unsubscribe(): void;
  armed: boolean;
  previous: OrchestrationShellSnapshot | null;
}

function defaultDeliver(
  triggers: ReadonlyArray<ThreadNotificationTrigger>,
  summaryCount: number,
): void {
  for (const trigger of triggers) {
    presentThreadNotification(trigger, {
      title: trigger.threadTitle,
      body: PRESENTATION_BY_KIND[trigger.kind],
    });
  }
  if (summaryCount > 0) {
    summarizeThreadNotifications(summaryCount);
  }
}

/**
 * Rising-edge thread notification observer. Subscribes every environment's
 * shell-snapshot atom through the app registry and delivers gated, throttled,
 * deduplicated notifications. Semantics:
 * - Per-environment baseline arming: the first observation NEVER notifies.
 * - Dedupe by `dedupeKey`, remembered for 5 × THROTTLE_MS.
 * - Global throttle: at most one batch per THROTTLE_MS; `lastShownAt` moves
 *   only when something is delivered. Throttled batches are DROPPED (not
 *   queued) — edges live in snapshot diffs, so a stale edge cannot resurface.
 * - Batches larger than MAX_TRIGGERS_PER_BATCH collapse into one summary;
 *   every trigger in the batch counts as shown.
 *
 * Returns a cleanup that fully unwinds (catalog + every env subscription), so
 * StrictMode mount→cleanup→mount is safe without any module guard.
 */
export function installThreadNotifications(deps: ObserverDeps = {}): () => void {
  const registry = deps.registry ?? appAtomRegistry;
  const catalogValueAtom = deps.catalogValueAtom ?? environmentCatalog.catalogValueAtom;
  const snapshotAtom = deps.snapshotAtom ?? environmentSnapshotAtom;
  const readSettings = deps.readSettings ?? getClientSettings;
  const focused = deps.focused ?? (() => document.hasFocus());
  const now = deps.now ?? (() => new Date().toISOString());
  const deliver = deps.deliver ?? defaultDeliver;

  // Bookkeeping is owned by this installation and fully unwound on cleanup.
  const shownKeys = new Map<string, number>();
  const environments = new Map<EnvironmentId, EnvironmentSubscriptionState>();
  let lastShownAt: number | null = null;

  function epochMs(): number {
    return Date.parse(now());
  }

  function pruneShownKeys(epoch: number): void {
    for (const [key, shownAt] of shownKeys) {
      if (epoch - shownAt >= SHOWN_KEY_TTL_MS) {
        shownKeys.delete(key);
      }
    }
  }

  function processTriggers(
    environmentId: EnvironmentId,
    previous: OrchestrationShellSnapshot | null,
    next: OrchestrationShellSnapshot | null,
  ): void {
    const epoch = epochMs();
    const triggers = diffThreadNotificationTriggers({
      environmentId,
      previous,
      next,
      now: now(),
    });
    if (triggers.length === 0) return;

    pruneShownKeys(epoch);

    const activeThreadRef = getActiveThreadRoute();
    const settings = readSettings();
    const context = { focused: focused(), activeThreadRef };

    const fresh = triggers.filter((trigger) => !shownKeys.has(trigger.dedupeKey));
    if (fresh.length === 0) return;

    const deliverable = fresh.filter((trigger) =>
      shouldDeliverThreadNotification({ trigger, settings, context }),
    );
    if (deliverable.length === 0) return;

    if (lastShownAt !== null && epoch - lastShownAt < THROTTLE_MS) return;
    lastShownAt = epoch;
    for (const trigger of deliverable) {
      shownKeys.set(trigger.dedupeKey, epoch);
    }

    const summary = summarizeThreadNotificationTriggers(deliverable);
    deliver(summary.triggers, summary.summaryCount);
  }

  function subscribeEnvironment(environmentId: EnvironmentId): void {
    if (environments.has(environmentId)) return;
    const atom = snapshotAtom(environmentId);
    const state: EnvironmentSubscriptionState = {
      unsubscribe: () => {},
      armed: false,
      previous: null,
    };
    state.unsubscribe = registry.subscribe(atom, (next) => {
      const prior = state.previous;
      state.previous = next;
      if (!state.armed) {
        // Baseline: arm on first observation, never notify.
        state.armed = true;
        return;
      }
      processTriggers(environmentId, prior, next);
    });
    environments.set(environmentId, state);
  }

  function syncEnvironments(catalog: EnvironmentCatalogState): void {
    const nextIds = new Set(catalog.entries.keys());
    for (const [environmentId, state] of environments) {
      if (!nextIds.has(environmentId)) {
        state.unsubscribe();
        environments.delete(environmentId);
      }
    }
    for (const environmentId of nextIds) {
      subscribeEnvironment(environmentId);
    }
  }

  syncEnvironments(registry.get(catalogValueAtom));
  const unsubscribeCatalog = registry.subscribe(catalogValueAtom, syncEnvironments);

  return () => {
    unsubscribeCatalog();
    for (const state of environments.values()) {
      state.unsubscribe();
    }
    environments.clear();
    shownKeys.clear();
  };
}
