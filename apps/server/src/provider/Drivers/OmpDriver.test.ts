import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { OmpDriver } from "./OmpDriver.ts";

const layerTest = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer({ runBackgroundWork: false }).pipe(Layer.provide(NodeServices.layer)),
  ServerConfig.layerTest(process.cwd(), { prefix: "omp-driver-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("Oh My Pi startup must not make an HTTP request")),
  ),
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({
    shouldRunScopeWork: () => Effect.succeed(false),
  }),
).pipe(Layer.provideMerge(NodeServices.layer));

const ompDriver = ProviderDriverKind.make("omp");

it.layer(layerTest)("OmpDriver", (it) => {
  it.effect("create succeeds and the snapshot identifies the omp driver", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("omp-driver-startup");
      const instance = yield* OmpDriver.create({
        instanceId,
        displayName: "Oh My Pi",
        enabled: false,
        environment: [],
        config: { ...OmpDriver.defaultConfig(), binaryPath: "/no/such/omp" },
      }).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("Oh My Pi startup must not spawn a process")),
        ),
      );
      expect(yield* instance.snapshot.getSnapshot).toMatchObject({
        driver: ompDriver,
        instanceId,
      });
    }).pipe(Effect.scoped),
  );
});
