import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

export interface ThreadNotificationOptions {
  readonly title: string;
  readonly body: string;
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
  }
>()("@t3tools/desktop/electron/ElectronNotifications") {}

export const make = ElectronNotifications.of({
  isSupported: Effect.sync(() => Electron.Notification.isSupported()),
  show: (options, onClick) =>
    Effect.sync(() => {
      const notification = new Electron.Notification(options);
      notification.on("click", () => {
        Effect.runFork(onClick);
      });
      notification.show();
    }),
});

export const layer = Layer.succeed(ElectronNotifications, make);
