import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";

const { FakeNotification, instances } = vi.hoisted(() => {
  const instances: FakeNotification[] = [];
  class FakeNotification {
    static isSupported = () => true;
    readonly listeners = new Map<string, Array<() => void>>();
    shown = 0;
    closed = 0;
    readonly options: { readonly title: string; readonly body: string; readonly silent: boolean };
    constructor(options: {
      readonly title: string;
      readonly body: string;
      readonly silent: boolean;
    }) {
      this.options = options;
      instances.push(this);
    }
    on(event: string, callback: () => void) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), callback]);
      return this;
    }
    emit(event: string) {
      for (const callback of this.listeners.get(event) ?? []) callback();
    }
    show() {
      this.shown += 1;
    }
    // Native close events may arrive later than the explicit close call.
    close() {
      this.closed += 1;
    }
  }
  return { FakeNotification, instances };
});
vi.mock("electron", () => ({ Notification: FakeNotification }));

import * as ElectronNotifications from "./ElectronNotifications.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import { showThreadNotification, closeThreadNotification } from "../ipc/methods/notifications.ts";

beforeEach(() => instances.splice(0));

it.effect("replaces tagged native alerts without letting a late close remove the replacement", () =>
  Effect.gen(function* () {
    const notifications = yield* ElectronNotifications.make;
    yield* notifications.show(
      { title: "Approval", body: "First", tag: "thread:approval" },
      Effect.void,
    );
    yield* notifications.show(
      { title: "Approval", body: "Second", tag: "thread:approval" },
      Effect.void,
    );
    const [first, second] = instances;
    assert.equal(first?.closed, 1);
    assert.equal(second?.shown, 1);
    first!.emit("close");
    yield* notifications.close("thread:approval");
    assert.equal(second?.closed, 1);
    yield* notifications.close("thread:approval");
    assert.equal(second?.closed, 1);
  }).pipe(Effect.scoped),
);

it.effect("forgets closed and clicked handles and ignores clicks from replaced alerts", () =>
  Effect.gen(function* () {
    const notifications = yield* ElectronNotifications.make;
    const clicked = yield* Deferred.make<void>();
    let clicks = 0;
    const onClick = Effect.sync(() => {
      clicks += 1;
    }).pipe(Effect.andThen(Deferred.succeed(clicked, undefined)));
    yield* notifications.show({ title: "Approval", body: "Old", tag: "approval" }, onClick);
    yield* notifications.show({ title: "Approval", body: "New", tag: "approval" }, onClick);
    instances[0]!.emit("click");
    instances[1]!.emit("click");
    yield* Deferred.await(clicked);
    assert.equal(clicks, 1);
    yield* notifications.close("approval");
    assert.equal(instances[1]?.closed, 1);
    yield* notifications.show({ title: "Finished", body: "Closed", tag: "finished" }, Effect.void);
    instances[2]!.emit("close");
    yield* notifications.close("finished");
    assert.equal(instances[2]?.closed, 0);
    yield* notifications.show({ title: "Failed", body: "Unavailable", tag: "failed" }, Effect.void);
    instances[3]!.emit("failed");
    yield* notifications.close("failed");
    assert.equal(instances[3]?.closed, 0);
  }).pipe(Effect.scoped),
);

it.effect("closes only still-live handles when its service scope ends", () =>
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const notifications = yield* ElectronNotifications.make;
      yield* notifications.show({ title: "Tagged", body: "Open", tag: "tagged" }, Effect.void);
      yield* notifications.show({ title: "Untagged", body: "Open" }, Effect.void);
      yield* notifications.show({ title: "Closed", body: "Done", tag: "closed" }, Effect.void);
      instances[2]!.emit("close");
    }).pipe(Effect.scoped);
    assert.deepEqual(
      instances.map((notification) => notification.closed),
      [1, 1, 0],
    );
  }),
);

it.effect("IPC replaces and dismisses actual native handles using decoded tags", () =>
  Effect.gen(function* () {
    yield* showThreadNotification.handler({ title: "Approval", body: "First", tag: " approval " });
    yield* showThreadNotification.handler({ title: "Approval", body: "Second", tag: "approval" });
    assert.deepEqual(
      instances.map((notification) => notification.closed),
      [1, 0],
    );
    assert.deepEqual(instances[1]?.options, { title: "Approval", body: "Second", silent: true });
    yield* closeThreadNotification.handler(" approval ");
    yield* closeThreadNotification.handler("approval");
    assert.deepEqual(
      instances.map((notification) => notification.closed),
      [1, 1],
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(ElectronNotifications.layer, Layer.mock(DesktopWindow.DesktopWindow)({})),
    ),
    Effect.scoped,
  ),
);
