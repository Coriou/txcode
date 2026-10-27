import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  OMP_OPENROUTER_ROUTING_EXTENSION_SOURCE,
  OMP_OPENROUTER_ROUTING_ENV,
  ompOpenRouterPinFileName,
  ompOpenRouterRoutingPaths,
  openRouterUpstreamFromSelection,
  openRouterUpstreamsFromSetting,
  prepareOmpOpenRouterRouting,
  resolvePinnedUpstream,
  writeOmpOpenRouterPin,
} from "./OmpOpenRouterRouting.ts";

const PINNED_MODEL = "openrouter/deepseek/deepseek-v4-flash";

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

  it("drops a stored pin the instance no longer offers", () => {
    const selections = [{ id: "openrouterUpstream", value: "deepinfra" }];
    expect(resolvePinnedUpstream(selections, ["cerebras"])).toBeUndefined();
    expect(resolvePinnedUpstream(selections, ["deepinfra"])).toBe("deepinfra");
    expect(resolvePinnedUpstream([], ["deepinfra"])).toBeUndefined();
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
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-routing-" });
      const paths = yield* ompOpenRouterRoutingPaths(stateDir);

      yield* prepareOmpOpenRouterRouting(paths);

      expect(yield* fs.readFileString(paths.extensionPath)).toBe(
        OMP_OPENROUTER_ROUTING_EXTENSION_SOURCE,
      );

      const pinPath = path.join(paths.pinsDir, ompOpenRouterPinFileName("session with/slash"));
      yield* writeOmpOpenRouterPin({
        paths,
        sessionId: "session with/slash",
        model: PINNED_MODEL,
        upstream: "deepinfra",
      });
      expect(pinPath).not.toContain("/slash");
      expect(yield* fs.readFileString(pinPath)).toBe(`deepinfra\n${PINNED_MODEL}\n`);

      yield* writeOmpOpenRouterPin({
        paths,
        sessionId: "session with/slash",
        model: PINNED_MODEL,
        upstream: undefined,
      });
      expect(yield* fs.exists(pinPath)).toBe(false);
    }),
  );

  it.effect("the generated extension pins only the model the thread chose", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-routing-ext-" });
      const paths = yield* ompOpenRouterRoutingPaths(stateDir);
      yield* prepareOmpOpenRouterRouting(paths);
      yield* writeOmpOpenRouterPin({
        paths,
        sessionId: "pinned-session",
        model: PINNED_MODEL,
        upstream: "deepinfra",
      });

      const modulePath = path.join(stateDir, "extension-for-test.mjs");
      yield* fs.writeFileString(modulePath, OMP_OPENROUTER_ROUTING_EXTENSION_SOURCE);
      const previousRoutingDir = process.env[OMP_OPENROUTER_ROUTING_ENV];
      process.env[OMP_OPENROUTER_ROUTING_ENV] = paths.dir;
      const handlers: Array<(event: { payload: unknown }, ctx: unknown) => unknown> = [];
      try {
        const module: { default: (pi: unknown) => void } = yield* Effect.promise(
          () => import(modulePath),
        );
        module.default({
          on: (event: string, handler: (typeof handlers)[number]) => {
            if (event === "before_provider_request") handlers.push(handler);
          },
        });
      } finally {
        if (previousRoutingDir === undefined) delete process.env[OMP_OPENROUTER_ROUTING_ENV];
        else process.env[OMP_OPENROUTER_ROUTING_ENV] = previousRoutingDir;
      }
      const handler = handlers[0];
      expect(handler).toBeDefined();
      const ctxFor = (provider: string, id: string, sessionId: string) => ({
        model: { provider, id },
        sessionManager: { getSessionId: () => sessionId },
      });

      const payload = { model: "deepseek/deepseek-v4-flash", messages: [] };
      expect(
        handler?.(
          { payload },
          ctxFor("openrouter", "deepseek/deepseek-v4-flash", "pinned-session"),
        ),
      ).toEqual({
        ...payload,
        provider: { only: ["deepinfra"] },
      });
      // Compaction and handoff send other models through the same hook.
      expect(
        handler?.({ payload }, ctxFor("openrouter", "openai/gpt-5-nano", "pinned-session")),
      ).toBeUndefined();
      expect(
        handler?.({ payload }, ctxFor("anthropic", "claude-sonnet-5", "pinned-session")),
      ).toBeUndefined();
      expect(
        handler?.({ payload }, ctxFor("openrouter", "deepseek/deepseek-v4-flash", "other-session")),
      ).toBeUndefined();
    }),
  );
});
