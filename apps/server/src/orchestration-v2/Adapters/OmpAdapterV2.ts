// Fork-local: Oh My Pi keeps its native harness; upstream owns ACP orchestration.
import { OmpSettings, ProviderDriverKind } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import * as AcpErrors from "effect-acp/errors";

import * as ServerConfig from "../../config.ts";
import { makeAcpNativeLoggerFactory } from "../../provider/acp/AcpNativeLogging.ts";
import { acpPermissionDisposition } from "../../provider/acp/AcpClientPolicy.ts";
import {
  acpContentBlockDisplayText,
  parsePermissionRequest,
} from "../../provider/acp/AcpRuntimeModel.ts";
import {
  applyOmpRequestedSessionConfiguration,
  buildOmpElicitationContent,
  makeOmpAcpRuntime,
  ompElicitationQuestions,
  selectAutoApprovedOmpPermissionOption,
  selectOmpPermissionOptionId,
  shouldAutoApproveOmpPermission,
} from "../../provider/acp/OmpAcpSupport.ts";
import * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import * as ProviderEventLoggers from "../../provider/ProviderEventLoggers.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
} from "./AcpAdapterV2.ts";

export const OMP_PROVIDER = ProviderDriverKind.make("omp");
const DEFAULT_OMP_SETTINGS = Schema.decodeSync(OmpSettings)({});
const isAcpRequestError = Schema.is(AcpErrors.AcpRequestError);
const EMPTY_RESPONSE_MESSAGE =
  "The agent returned no response content (empty completions from the model). Retry the turn or switch models.";

export interface OmpAdapterV2Options extends Omit<
  Parameters<typeof makeAcpAdapterV2>[0],
  "flavor"
> {
  readonly settings: OmpSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly makeRuntime?: AcpAdapterV2Flavor["makeRuntime"];
}

/** Count root assistant output on the native transport, including frames before RPC settlement. */
function withOmpCompletionCheck(runtime: AcpSessionRuntime.AcpSessionRuntime["Service"]) {
  let sessionId: string | undefined;
  let promptActive = false;
  let producedContent = false;
  const rememberSession = (started: AcpSessionRuntime.AcpSessionRuntimeStartResult) =>
    Effect.sync(() => {
      sessionId = started.sessionId;
    });
  return {
    ...runtime,
    start: () => runtime.start().pipe(Effect.tap(rememberSession)),
    loadSession: (...args: Parameters<typeof runtime.loadSession>) =>
      runtime.loadSession(...args).pipe(Effect.tap(rememberSession)),
    resumeSession: (...args: Parameters<typeof runtime.resumeSession>) =>
      runtime.resumeSession(...args).pipe(Effect.tap(rememberSession)),
    handleSessionUpdate: (handler: Parameters<typeof runtime.handleSessionUpdate>[0]) =>
      runtime.handleSessionUpdate((notification) =>
        Effect.gen(function* () {
          if (
            promptActive &&
            notification.sessionId === sessionId &&
            notification.update.sessionUpdate === "agent_message_chunk" &&
            (acpContentBlockDisplayText(notification.update.content)?.length ?? 0) > 0
          )
            producedContent = true;
          yield* handler(notification);
        }),
      ),
    prompt: (...args: Parameters<typeof runtime.prompt>) =>
      Effect.gen(function* () {
        promptActive = true;
        producedContent = false;
        const result = yield* runtime.prompt(...args);
        if (result.stopReason !== "cancelled" && !producedContent) {
          return yield* new AcpErrors.AcpRequestError({
            code: -32603,
            errorMessage: EMPTY_RESPONSE_MESSAGE,
            method: "session/prompt",
          });
        }
        return result;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            promptActive = false;
          }),
        ),
      ),
  } satisfies AcpSessionRuntime.AcpSessionRuntime["Service"];
}

export function makeOmpAcpAdapterFlavor(options: OmpAdapterV2Options): AcpAdapterV2Flavor {
  return {
    driver: OMP_PROVIDER,
    runtimeHarness: "Oh My Pi",
    capabilities: {
      ...AcpProviderCapabilitiesV2,
      sessions: { ...AcpProviderCapabilitiesV2.sessions, supportsModelSwitchInSession: true },
      threads: { ...AcpProviderCapabilitiesV2.threads, canRollbackThread: false },
    },
    preparePrompt: ({ prompt }) => prompt,
    appendRuntimeInstructions: false,
    promptFailure: (cause) =>
      makeProviderFailure({
        cause,
        ...(isAcpRequestError(cause)
          ? { message: cause.errorMessage, code: String(cause.code) }
          : {}),
      }),
    permissionDisposition: (policy, request) =>
      policy.approvalPolicy !== undefined || policy.sandboxPolicy !== undefined
        ? acpPermissionDisposition(policy, request)
        : shouldAutoApproveOmpPermission(policy.runtimeMode, parsePermissionRequest(request))
          ? "allow"
          : "ask",
    selectPermissionOptionId: selectOmpPermissionOptionId,
    selectAutoApprovedPermissionOption: selectAutoApprovedOmpPermissionOption,
    mapFormElicitation: (request) => {
      const questions = ompElicitationQuestions(request);
      if (questions.length === 0) return undefined;
      return {
        questions: questions.map(({ question }) => question),
        content: (answers) => buildOmpElicitationContent(questions, answers),
      };
    },
    applyModelSelection: ({ runtime, modelSelection }) =>
      applyOmpRequestedSessionConfiguration({
        runtime,
        modelSelection,
        mapError: ({ cause }) => cause,
      }).pipe(Effect.as(modelSelection.model === "default" ? undefined : modelSelection.model)),
    makeRuntime: (input) =>
      (
        options.makeRuntime?.(input) ??
        makeOmpAcpRuntime({
          ...input,
          ompSettings: options.settings,
          environment: { ...options.environment, ...input.processEnvironment },
          runtimeMode:
            input.runtimePolicy.approvalPolicy === undefined &&
            input.runtimePolicy.sandboxPolicy === undefined
              ? input.runtimePolicy.runtimeMode
              : "approval-required",
          childProcessSpawner: options.childProcessSpawner,
        })
      ).pipe(Effect.map(withOmpCompletionCheck)),
  };
}

export function makeOmpAdapterV2(options: OmpAdapterV2Options) {
  return makeAcpAdapterV2({ ...options, flavor: makeOmpAcpAdapterFlavor(options) });
}

export type OmpAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | IdAllocator.IdAllocatorV2
  | ProviderEventLoggers.ProviderEventLoggers
  | ServerConfig.ServerConfig;

export const OmpAdapterV2Driver: ProviderAdapterDriver<OmpSettings, OmpAdapterV2DriverEnv> = {
  driverKind: OMP_PROVIDER,
  configSchema: OmpSettings,
  defaultConfig: (): OmpSettings => DEFAULT_OMP_SETTINGS,
  create: Effect.fn("OmpAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<OmpSettings>) {
      const hostEnvironment = yield* HostProcessEnvironment;
      const eventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return makeOmpAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        crypto: yield* Crypto.Crypto,
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* ServerConfig.ServerConfig,
        selfInvocation: yield* resolveSelfInvocation(),
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: eventLoggers.native,
            provider: OMP_PROVIDER,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: OMP_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create Oh My Pi ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};
