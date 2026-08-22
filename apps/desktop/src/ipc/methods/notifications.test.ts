import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type * as Electron from "electron";

import * as ElectronNotifications from "../../electron/ElectronNotifications.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { showThreadNotification } from "./notifications.ts";

const threadRef = { environmentId: "environment-a", threadId: "thread-1" };

function makeHarness(
  options: {
    readonly supported?: boolean;
    readonly windows?: ReadonlyArray<Electron.BrowserWindow>;
  } = {},
) {
  const shown: Array<{ readonly title: string; readonly body: string }> = [];
  const clicks: Array<Effect.Effect<void>> = [];
  const revealed: Array<Electron.BrowserWindow> = [];
  const sent: Array<readonly [channel: string, args: readonly unknown[]]> = [];

  const notificationsLayer = Layer.mock(ElectronNotifications.ElectronNotifications)({
    isSupported: Effect.succeed(options.supported ?? true),
    show: (notificationOptions, onClick) =>
      Effect.sync(() => {
        shown.push(notificationOptions);
        clicks.push(onClick);
      }),
  });

  const windows = options.windows ?? [];
  const windowLayer = Layer.mock(ElectronWindow.ElectronWindow)({
    currentMainOrFirst: Effect.succeed(Option.fromNullishOr(windows[0] ?? null)),
    reveal: (window) =>
      Effect.sync(() => {
        revealed.push(window);
      }),
    sendAll: (channel, ...args) =>
      Effect.sync(() => {
        sent.push([channel, args]);
      }),
  });

  const layer = Layer.mergeAll(notificationsLayer, windowLayer);

  return { layer, shown, clicks, revealed, sent };
}

async function runClick(click: Effect.Effect<void> | undefined): Promise<void> {
  assert.isDefined(click);
  await Effect.runPromise(click);
}

describe("showThreadNotification", () => {
  it.effect("decodes the payload and shows a native notification", () =>
    Effect.gen(function* () {
      const harness = makeHarness();

      const result = yield* showThreadNotification
        .handler({
          title: "  Thread 1  ",
          body: "Turn completed",
          threadRef,
        })
        .pipe(Effect.provide(harness.layer));

      assert.isUndefined(result);
      assert.deepStrictEqual(harness.shown, [{ title: "Thread 1", body: "Turn completed" }]);
      assert.deepStrictEqual(harness.sent, []);
    }),
  );

  it.effect("rejects payloads whose title is blank", () =>
    Effect.gen(function* () {
      const harness = makeHarness();

      const exit = yield* Effect.exit(
        showThreadNotification
          .handler({ title: "   ", body: "Turn completed", threadRef })
          .pipe(Effect.provide(harness.layer)),
      );

      assert.isTrue(Exit.isFailure(exit));
      assert.deepStrictEqual(harness.shown, []);
    }),
  );

  it.effect("short-circuits when native notifications are unsupported", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ supported: false });

      const result = yield* showThreadNotification
        .handler({
          title: "Thread 1",
          body: "Turn completed",
          threadRef,
        })
        .pipe(Effect.provide(harness.layer));

      assert.isUndefined(result);
      assert.deepStrictEqual(harness.shown, []);
    }),
  );

  it.effect("click reveals the existing window and broadcasts the activation channel", () =>
    Effect.gen(function* () {
      const window = { id: 1 } as Electron.BrowserWindow;
      const harness = makeHarness({ windows: [window] });

      yield* showThreadNotification
        .handler({
          title: "Thread 1",
          body: "Turn completed",
          threadRef,
        })
        .pipe(Effect.provide(harness.layer));

      assert.strictEqual(harness.clicks.length, 1);
      yield* Effect.promise(() => runClick(harness.clicks[0]));

      assert.deepStrictEqual(harness.revealed, [window]);
      assert.deepStrictEqual(harness.sent, [["desktop:thread-notification-activate", [threadRef]]]);
    }),
  );

  it.effect("click without a live window still broadcasts the activation channel", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ windows: [] });

      yield* showThreadNotification
        .handler({
          title: "Thread 1",
          body: "Turn completed",
          threadRef,
        })
        .pipe(Effect.provide(harness.layer));

      assert.strictEqual(harness.clicks.length, 1);
      yield* Effect.promise(() => runClick(harness.clicks[0]));

      assert.deepStrictEqual(harness.revealed, []);
      assert.deepStrictEqual(harness.sent, [["desktop:thread-notification-activate", [threadRef]]]);
    }),
  );
});
