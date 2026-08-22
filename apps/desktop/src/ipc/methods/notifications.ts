import { ShowThreadNotificationInputSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ElectronNotifications from "../../electron/ElectronNotifications.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const showThreadNotification = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SHOW_THREAD_NOTIFICATION_CHANNEL,
  payload: ShowThreadNotificationInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.notifications.show")(function* (input) {
    const notifications = yield* ElectronNotifications.ElectronNotifications;
    if (!(yield* notifications.isSupported)) {
      return;
    }

    const electronWindow = yield* ElectronWindow.ElectronWindow;
    // Clicking the notification reveals the EXISTING window (never spawns one)
    // and tells every renderer which thread to open.
    yield* notifications.show(
      { title: input.title, body: input.body },
      Effect.gen(function* () {
        const window = yield* electronWindow.currentMainOrFirst;
        if (Option.isSome(window)) {
          yield* electronWindow.reveal(window.value);
        }
        yield* electronWindow.sendAll(
          IpcChannels.THREAD_NOTIFICATION_ACTIVATE_CHANNEL,
          input.threadRef,
        );
      }).pipe(Effect.ignore),
    );
  }),
});
