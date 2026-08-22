import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import type * as Electron from "electron";

import * as ElectronNotifications from "../../electron/ElectronNotifications.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import { showThreadNotification } from "./notifications.ts";

const threadRef = { environmentId: "environment-a", threadId: "thread-1" };

interface FakeWindow {
  readonly id: number;
  isDestroyed(): boolean;
  webContents: {
    send(channel: string, ...args: readonly unknown[]): void;
  };
}

interface SentMessage {
  readonly window: FakeWindow;
  readonly channel: string;
  readonly args: readonly unknown[];
}

function makeHarness(
  options: {
    readonly supported?: boolean;
    /** Live main-window doubles available before the first click. */
    readonly windowCount?: number;
  } = {},
) {
  const shown: Array<{ readonly title: string; readonly body: string }> = [];
  const clicks: Array<Effect.Effect<void>> = [];
  const revealed: Array<Electron.BrowserWindow> = [];
  const created: Array<Electron.BrowserWindow> = [];
  // Single recorder shared by every window double, so assertions see all sends.
  const sent: Array<SentMessage> = [];

  let nextWindowId = 1;
  const makeWindow = (): Electron.BrowserWindow => {
    const window: FakeWindow = {
      id: nextWindowId,
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, ...args: readonly unknown[]) => {
          sent.push({ window, channel, args });
        },
      },
    };
    nextWindowId += 1;
    return window as unknown as Electron.BrowserWindow;
  };

  const notificationsLayer = Layer.mock(ElectronNotifications.ElectronNotifications)({
    isSupported: Effect.succeed(options.supported ?? true),
    show: (notificationOptions, onClick) =>
      Effect.sync(() => {
        shown.push(notificationOptions);
        clicks.push(onClick);
      }),
  });

  const windows = Array.from({ length: options.windowCount ?? 0 }, () => makeWindow());
  const windowLayer = Layer.mock(DesktopWindow.DesktopWindow)({
    // Mirrors DesktopWindow.revealOrCreateMain: reuse the live main window or
    // create one when none exists.
    revealOrCreateMain: Effect.sync(() => {
      const existing = windows[0];
      if (existing) {
        revealed.push(existing);
        return existing;
      }
      const window = makeWindow();
      created.push(window);
      revealed.push(window);
      return window;
    }),
  });

  const layer = Layer.mergeAll(notificationsLayer, windowLayer);

  return { layer, shown, clicks, revealed, created, sent, windows };
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

  it.effect("click reveals the existing window and activates only that renderer", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ windowCount: 2 });
      const [mainWindow, otherWindow] = harness.windows;
      if (!mainWindow || !otherWindow) {
        throw new Error("expected two live windows");
      }

      yield* showThreadNotification
        .handler({
          title: "Thread 1",
          body: "Turn completed",
          threadRef,
        })
        .pipe(Effect.provide(harness.layer));

      assert.strictEqual(harness.clicks.length, 1);
      yield* Effect.promise(() => runClick(harness.clicks[0]));

      assert.deepStrictEqual(harness.revealed, [mainWindow]);
      assert.strictEqual(harness.created.length, 0);
      assert.deepStrictEqual(harness.sent, [
        {
          window: mainWindow,
          channel: "desktop:thread-notification-activate",
          args: [threadRef],
        },
      ]);
    }),
  );

  it.effect("click without a live window creates the main window and activates it", () =>
    Effect.gen(function* () {
      const harness = makeHarness();

      yield* showThreadNotification
        .handler({
          title: "Thread 1",
          body: "Turn completed",
          threadRef,
        })
        .pipe(Effect.provide(harness.layer));

      assert.strictEqual(harness.clicks.length, 1);
      yield* Effect.promise(() => runClick(harness.clicks[0]));

      assert.strictEqual(harness.created.length, 1);
      const createdWindow = harness.created.at(0);
      if (!createdWindow) {
        throw new Error("expected a created main window");
      }
      assert.deepStrictEqual(harness.revealed, [createdWindow]);
      assert.deepStrictEqual(harness.sent, [
        {
          window: createdWindow,
          channel: "desktop:thread-notification-activate",
          args: [threadRef],
        },
      ]);
    }),
  );

  it.effect("summary payload without a threadRef reveals the window but sends nothing", () =>
    Effect.gen(function* () {
      const harness = makeHarness();

      yield* showThreadNotification
        .handler({ title: "Threads need your attention", body: "4 threads have updates." })
        .pipe(Effect.provide(harness.layer));

      assert.strictEqual(harness.clicks.length, 1);
      yield* Effect.promise(() => runClick(harness.clicks[0]));

      assert.strictEqual(harness.created.length, 1);
      assert.deepStrictEqual(harness.sent, []);
    }),
  );
});
