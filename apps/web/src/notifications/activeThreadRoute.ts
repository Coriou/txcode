import type { ScopedThreadRef } from "@t3tools/contracts";

let activeRef: ScopedThreadRef | null = null;

/**
 * The thread route currently rendered in THIS tab; null on drafts/index/unmounted.
 * Read by the notification observer to apply the "unfocused-or-different-thread"
 * focus rule; written by the thread route component on mount/param change.
 */
export function setActiveThreadRoute(ref: ScopedThreadRef | null): void {
  activeRef = ref;
}

export function getActiveThreadRoute(): ScopedThreadRef | null {
  return activeRef;
}
