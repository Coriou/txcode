import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLegacyLocalStorage from "./DesktopLegacyLocalStorage.ts";

/** Minimal valid LevelDB WAL fixture: one Chromium localStorage item and no SST files. */
const logRecord = (payload: Uint8Array) => {
  const data = new Uint8Array(payload.length + 1);
  data[0] = 1;
  data.set(payload, 1);
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const masked = (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0;
  const record = new Uint8Array(payload.length + 7);
  const header = new DataView(record.buffer);
  header.setUint32(0, masked, true);
  header.setUint16(4, payload.length, true);
  record[6] = 1;
  record.set(payload, 7);
  return record;
};

const writeProfileFixture = Effect.fnUntraced(function* (directory: string, value: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const key = new TextEncoder().encode("_t3code://app\0\x01prompt-stash");
  const encodedValue = new TextEncoder().encode(`\x01${value}`);
  const batch = new Uint8Array(15 + key.length + encodedValue.length);
  const header = new DataView(batch.buffer);
  header.setUint32(0, 1, true);
  header.setUint32(8, 1, true);
  batch[12] = 1;
  batch[13] = key.length;
  batch.set(key, 14);
  batch[14 + key.length] = encodedValue.length;
  batch.set(encodedValue, 15 + key.length);
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.writeFileString(path.join(directory, "CURRENT"), "MANIFEST-000001\n");
  yield* fs.writeFile(
    path.join(directory, "MANIFEST-000001"),
    logRecord(new Uint8Array([2, 2, 3, 3, 4, 1])),
  );
  yield* fs.writeFile(path.join(directory, "000002.log"), logRecord(batch));
  yield* fs.writeFileString(path.join(directory, "LOCK"), "V1 owns this database");
});

it.effect.each(["txcode", "Tx Code (Legacy)"])(
  "imports copied fork V1 localStorage from %s and completes once",
  (sourceName) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "tx-v1-import-" });
      const source = path.join(root, sourceName, "Local Storage", "leveldb");
      const destination = path.join(root, "txcode-v2");
      yield* writeProfileFixture(source, "saved fork draft");
      yield* fs.makeDirectory(destination);
      const sourceBefore = yield* fs.readFile(path.join(source, "000002.log"));
      yield* Effect.gen(function* () {
        const migration = yield* DesktopLegacyLocalStorage.DesktopLegacyLocalStorage;
        yield* migration.load(destination);
        assert.deepEqual(
          yield* migration.take,
          Option.some({ "prompt-stash": "saved fork draft" }),
        );
        assert.deepEqual(yield* migration.take, Option.none());
        assert.isFalse(yield* fs.exists(path.join(destination, "v1-local-storage-imported")));
        yield* migration.complete;
        assert.isTrue(yield* fs.exists(path.join(destination, "v1-local-storage-imported")));
        yield* migration.load(destination);
        assert.deepEqual(yield* migration.take, Option.none());
      }).pipe(
        Effect.provide(DesktopLegacyLocalStorage.layer),
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
          isDevelopment: false,
          appDataDirectory: root,
        } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
      );
      assert.deepEqual(yield* fs.readFile(path.join(source, "000002.log")), sourceBefore);
      assert.equal(yield* fs.readFileString(path.join(source, "LOCK")), "V1 owns this database");
      assert.isFalse(yield* fs.exists(path.join(destination, "Local Storage")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("never imports official V1 profile localStorage", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "tx-official-import-isolation-" });
    for (const name of ["t3code", "T3 Code (Alpha)"]) {
      yield* writeProfileFixture(
        path.join(root, name, "Local Storage", "leveldb"),
        "official draft",
      );
    }
    const destination = path.join(root, "txcode-v2");
    yield* fs.makeDirectory(destination);
    yield* Effect.gen(function* () {
      const migration = yield* DesktopLegacyLocalStorage.DesktopLegacyLocalStorage;
      yield* migration.load(destination);
      assert.deepEqual(yield* migration.take, Option.none());
      assert.isTrue(yield* fs.exists(path.join(destination, "v1-local-storage-imported")));
    }).pipe(
      Effect.provide(DesktopLegacyLocalStorage.layer),
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
        isDevelopment: false,
        appDataDirectory: root,
      } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
