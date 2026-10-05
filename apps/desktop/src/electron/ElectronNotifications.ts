import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

export interface ThreadNotificationOptions {
  readonly title: string;
  readonly body: string;
  readonly tag?: string;
}

export class ElectronNotifications extends Context.Service<
  ElectronNotifications,
  {
    readonly isSupported: Effect.Effect<boolean>;
    /** Shows a native notification; `onClick` runs when the user clicks it. */
    readonly show: (
      options: ThreadNotificationOptions,
      onClick: Effect.Effect<void>,
    ) => Effect.Effect<void>;
    readonly close: (tag: string) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/electron/ElectronNotifications") {}

// Fork: native alerts share the coordinator's tag-based replace/dismiss lifecycle.
export const make = Effect.gen(function* () {
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const live = new Set<Electron.Notification>();
  const tagged = new Map<string, Electron.Notification>();
  const forget = (notification: Electron.Notification, tag: string | undefined) => {
    const removed = live.delete(notification);
    if (tag !== undefined && tagged.get(tag) === notification) tagged.delete(tag);
    return removed;
  };
  const close = (tag: string) =>
    Effect.sync(() => {
      const notification = tagged.get(tag);
      if (notification === undefined) return;
      forget(notification, tag);
      notification.close();
    });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      const notifications = [...live];
      live.clear();
      tagged.clear();
      for (const notification of notifications) notification.close();
    }),
  );

  return ElectronNotifications.of({
    isSupported: Effect.sync(() => Electron.Notification.isSupported()),
    close,
    show: (options, onClick) =>
      Effect.gen(function* () {
        if (options.tag !== undefined) yield* close(options.tag);
        yield* Effect.sync(() => {
          const notification = new Electron.Notification({
            title: options.title,
            body: options.body,
            silent: true,
          });
          live.add(notification);
          if (options.tag !== undefined) tagged.set(options.tag, notification);
          notification.on("close", () => forget(notification, options.tag));
          notification.on("failed", () => forget(notification, options.tag));
          notification.on("click", () => {
            if (!forget(notification, options.tag)) return;
            notification.close();
            runFork(onClick);
          });
          try {
            notification.show();
          } catch (cause) {
            forget(notification, options.tag);
            throw cause;
          }
        });
      }),
  });
});

export const layer = Layer.effect(ElectronNotifications, make);
