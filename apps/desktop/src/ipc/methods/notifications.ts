import { ShowThreadNotificationInputSchema, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ElectronNotifications from "../../electron/ElectronNotifications.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
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

    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    // Clicking always brings the app forward: reveal the existing main window
    // or CREATE one when none is live, then tell THAT renderer which thread
    // to open. Summaries carry no threadRef and only bring the window up.
    yield* notifications.show(
      {
        title: input.title,
        body: input.body,
        ...(input.tag === undefined ? {} : { tag: input.tag }),
      },
      Effect.gen(function* () {
        const window = yield* desktopWindow.revealOrCreateMain;
        if (!input.threadRef || window.isDestroyed()) {
          return;
        }
        // A dead renderer surfaces as a defect here; the surrounding
        // Effect.ignore treats the click path as best-effort either way.
        yield* Effect.sync(() =>
          window.webContents.send(
            IpcChannels.THREAD_NOTIFICATION_ACTIVATE_CHANNEL,
            input.threadRef,
          ),
        );
      }).pipe(Effect.ignore),
    );
  }),
});

export const closeThreadNotification = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CLOSE_THREAD_NOTIFICATION_CHANNEL,
  payload: TrimmedNonEmptyString,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.notifications.close")(function* (tag) {
    const notifications = yield* ElectronNotifications.ElectronNotifications;
    yield* notifications.close(tag);
  }),
});
