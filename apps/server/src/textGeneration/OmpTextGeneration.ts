import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import { type ChatAttachment, type OmpSettings, TextGenerationError } from "@t3tools/contracts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import {
  applyOmpAcpModelSelection,
  makeOmpTextGenerationAcpRuntime,
} from "../provider/acp/OmpAcpSupport.ts";
import {
  ompOpenRouterRoutingPaths,
  openRouterUpstreamFromSelection,
  openRouterUpstreamsFromSetting,
  writeOmpOpenRouterPin,
} from "../provider/acp/OmpOpenRouterRouting.ts";

const OMP_TIMEOUT_MS = 180_000;
const isTextGenerationError = Schema.is(TextGenerationError);

export const makeOmpTextGeneration = Effect.fn("makeOmpTextGeneration")(function* (
  ompSettings: OmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const crypto = yield* Crypto.Crypto;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig;
  const openRouterRouting =
    openRouterUpstreamsFromSetting(ompSettings.openrouterUpstreams).length > 0
      ? yield* ompOpenRouterRoutingPaths(serverConfig.stateDir)
      : undefined;
  const configuredUpstreams = openRouterUpstreamsFromSetting(ompSettings.openrouterUpstreams);

  const imagePromptParts = Effect.fn("OmpTextGeneration.imagePromptParts")(function* (
    attachments: ReadonlyArray<ChatAttachment> | undefined,
  ) {
    const parts: Array<EffectAcpSchema.ContentBlock> = [];
    for (const attachment of attachments ?? []) {
      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!attachmentPath) continue;
      const bytes = yield* fileSystem.readFile(attachmentPath).pipe(Effect.option);
      if (Option.isNone(bytes)) continue;
      parts.push({
        type: "image",
        data: Buffer.from(bytes.value).toString("base64"),
        mimeType: attachment.mimeType,
      });
    }
    return parts;
  });

  const runOmpJson: TextGenerationOperations.Runner = (request) => {
    const { operation, cwd, prompt, modelSelection, attachments } = request;
    return Effect.gen(function* () {
      const outputRef = yield* Ref.make("");
      const sessionDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-omp-text-session-",
      });
      const selectedUpstream = openRouterUpstreamFromSelection(modelSelection.options);
      const upstream =
        openRouterRouting !== undefined &&
        selectedUpstream !== undefined &&
        configuredUpstreams.includes(selectedUpstream)
          ? selectedUpstream
          : undefined;
      const runtime = yield* makeOmpTextGenerationAcpRuntime({
        ompSettings,
        environment,
        childProcessSpawner: commandSpawner,
        cwd,
        sessionDir,
        clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
        ...(upstream === undefined ? {} : { openRouterRouting }),
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));

      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (update.sessionUpdate !== "agent_message_chunk") return Effect.void;
        const content = update.content;
        if (content.type !== "text") return Effect.void;
        return Ref.update(outputRef, (current) => current + content.text);
      });
      yield* runtime.handleElicitation(() => Effect.succeed({ action: "cancel" as const }));
      yield* runtime.handleRequestPermission(() =>
        Effect.succeed({ outcome: { outcome: "cancelled" as const } }),
      );

      const promptResult = yield* Effect.gen(function* () {
        const started = yield* runtime.start();
        if (upstream !== undefined && openRouterRouting !== undefined) {
          yield* writeOmpOpenRouterPin({
            paths: openRouterRouting,
            sessionId: started.sessionId,
            model: modelSelection.model,
            upstream,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to write Oh My Pi OpenRouter pin", { cause }),
            ),
          );
        }
        yield* applyOmpAcpModelSelection({
          runtime,
          model: modelSelection.model,
          selections: modelSelection.options,
          mapError: ({ cause, configId, step }) =>
            new TextGenerationError({
              operation,
              detail:
                step === "set-config-option"
                  ? `Failed to set Oh My Pi ACP config option "${configId}" for text generation.`
                  : "Failed to set Oh My Pi ACP model for text generation.",
              cause,
            }),
        });
        return yield* runtime.prompt({
          prompt: [{ type: "text", text: prompt }, ...(yield* imagePromptParts(attachments))],
        });
      }).pipe(
        Effect.timeoutOption(OMP_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "Oh My Pi request timed out." }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.mapError((cause: EffectAcpErrors.AcpError | TextGenerationError) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: "Oh My Pi ACP request failed.",
                cause,
              }),
        ),
      );

      const rawResult = (yield* Ref.get(outputRef)).trim();
      if (!rawResult) {
        return yield* new TextGenerationError({
          operation,
          detail:
            promptResult.stopReason === "cancelled"
              ? "Oh My Pi ACP request was cancelled."
              : "Oh My Pi returned empty output.",
        });
      }

      return yield* TextGenerationOperations.decodeJsonReply(request, "Oh My Pi", rawResult);
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "Oh My Pi ACP text generation failed.",
              cause,
            }),
      ),
      Effect.scoped,
    );
  };

  // Text generation runs Oh My Pi with `--no-tools`, so it cannot investigate a checkout;
  // review guides fail with a typed error instead of answering blind.
  return TextGenerationOperations.fromRunner(
    "OmpTextGeneration",
    TextGenerationOperations.withoutInvestigation("Oh My Pi", runOmpJson),
  );
});
