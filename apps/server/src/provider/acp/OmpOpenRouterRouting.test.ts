import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  OMP_OPENROUTER_ROUTING_EXTENSION_SOURCE,
  OMP_OPENROUTER_ROUTING_ENV,
  ompOpenRouterPinPath,
  ompOpenRouterRoutingPaths,
  openRouterUpstreamFromSelection,
  openRouterUpstreamsFromSetting,
  prepareOmpOpenRouterRouting,
  writeOmpOpenRouterPin,
} from "./OmpOpenRouterRouting.ts";

describe("OpenRouter upstream setting", () => {
  it("normalizes comma-separated slugs and drops blanks and duplicates", () => {
    expect(openRouterUpstreamsFromSetting(" DeepInfra, cerebras ,, deepinfra, ")).toEqual([
      "deepinfra",
      "cerebras",
    ]);
    expect(openRouterUpstreamsFromSetting("")).toEqual([]);
    expect(openRouterUpstreamsFromSetting(null)).toEqual([]);
  });
});

describe("OpenRouter upstream selection", () => {
  it("reads the pin from the provider option selection", () => {
    expect(
      openRouterUpstreamFromSelection([
        { id: "thinking", value: "high" },
        { id: "openrouterUpstream", value: " DeepInfra " },
      ]),
    ).toBe("deepinfra");
  });

  it("treats auto and unrelated selections as unpinned", () => {
    expect(
      openRouterUpstreamFromSelection([{ id: "openrouterUpstream", value: "auto" }]),
    ).toBeUndefined();
    expect(openRouterUpstreamFromSelection([{ id: "thinking", value: "high" }])).toBeUndefined();
    expect(
      openRouterUpstreamFromSelection([{ id: "openrouterUpstream", value: true }]),
    ).toBeUndefined();
    expect(openRouterUpstreamFromSelection(null)).toBeUndefined();
  });
});

it.layer(NodeServices.layer)("OpenRouter routing artifacts", (it) => {
  it.effect("writes the extension and round-trips a session pin", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-routing-" });
      const paths = yield* ompOpenRouterRoutingPaths(stateDir);

      yield* prepareOmpOpenRouterRouting(paths);

      expect(yield* fs.readFileString(paths.extensionPath)).toBe(
        OMP_OPENROUTER_ROUTING_EXTENSION_SOURCE,
      );
      expect(OMP_OPENROUTER_ROUTING_EXTENSION_SOURCE).toContain('pi.on("before_provider_request"');
      expect(OMP_OPENROUTER_ROUTING_EXTENSION_SOURCE).toContain(OMP_OPENROUTER_ROUTING_ENV);

      yield* writeOmpOpenRouterPin({
        paths,
        sessionId: "session with/slash",
        upstream: "deepinfra",
      });
      const pinPath = ompOpenRouterPinPath(paths, "session with/slash");
      expect(pinPath.startsWith(paths.pinsDir)).toBe(true);
      expect(pinPath).not.toContain("/slash");
      expect(yield* fs.readFileString(pinPath)).toBe("deepinfra\n");

      yield* writeOmpOpenRouterPin({ paths, sessionId: "session with/slash", upstream: undefined });
      expect(yield* fs.exists(pinPath)).toBe(false);
    }),
  );
});
