import { createRouter, RouterHistory } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";

let activeRouter: AppRouter | null = null;

/** Module-level handle for non-React callers (notification deep-links). */
export function setActiveRouter(router: AppRouter): void {
  activeRouter = router;
}

export function getActiveRouter(): AppRouter | null {
  return activeRouter;
}

export function getRouter(history: RouterHistory) {
  return createRouter({
    routeTree,
    history,
    context: {},
  });
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
