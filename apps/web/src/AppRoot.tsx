import { RouterProvider } from "@tanstack/react-router";
import { useEffect } from "react";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { PreviewAutomationHosts } from "./components/preview/PreviewAutomationHosts";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { installThreadNotifications } from "./notifications/threadNotificationObserver";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

/**
 * Owns renderer-wide providers. The Electron browser host intentionally sits
 * outside the router so its webviews survive route transitions, but it must
 * share the same atom registry as routed UI.
 */

/**
 * Mounts the thread notification observer once. StrictMode-safe: cleanup
 * fully unwinds, so remount re-arms cleanly without any module guard.
 */
export function ThreadNotificationsHost() {
  useEffect(() => {
    const uninstallObserver = installThreadNotifications();
    // Desktop: clicking a native notification reveals the window (main
    // process) and tells us which thread to open. The deep-link helper is
    // loaded lazily: a static import here would pull the whole route tree
    // (and its workers) into every unit-test environment that renders
    // AppRoot.
    const unsubscribeActivate = window.desktopBridge?.onThreadNotificationActivate((ref) => {
      window.focus();
      void import("./notifications/deliverThreadNotification").then((m) =>
        m.openThreadFromNotification(ref),
      );
    });
    return () => {
      unsubscribeActivate?.();
      uninstallObserver();
    };
  }, []);
  return null;
}

export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
      <PreviewAutomationHosts />
      <ElectronBrowserHost />
      <QuitHoldOverlay />
      <ThreadNotificationsHost />
    </AppAtomRegistryProvider>
  );
}
