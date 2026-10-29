import type { EnvironmentId, ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { findEnvironmentUpdate } from "./environment-maintenance";

export interface EnvironmentReleaseCheck {
  readonly fromVersion: string;
  readonly updatePolicy?: ExecutionEnvironmentDescriptor["updatePolicy"];
  readonly desktopManaged: boolean;
  readonly targetVersion: string | null;
}

const asError = (cause: unknown) =>
  cause instanceof Error ? cause : new Error("Could not check for updates.");

/**
 * Looks up the newest T3 Code release for one environment. The atom is not
 * kept alive, so leaving the screen interrupts the lookup and aborts its fetch.
 * The argument reads the server version, which an outdated server only
 * reports through a separate description request.
 */
export const environmentReleaseCheckAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.fn(
    (
      readServerVersion: () => Promise<
        Pick<ExecutionEnvironmentDescriptor, "serverVersion" | "updatePolicy"> &
          Partial<Pick<ExecutionEnvironmentDescriptor, "capabilities">>
      >,
    ) =>
      Effect.gen(function* () {
        const descriptor = yield* Effect.tryPromise({ try: readServerVersion, catch: asError });
        const fromVersion = descriptor.serverVersion;
        const desktopManaged = descriptor.capabilities?.serverSelfUpdate === "desktop-managed";
        const targetVersion = yield* Effect.tryPromise({
          try: (signal) =>
            findEnvironmentUpdate(fromVersion, signal, descriptor.updatePolicy, desktopManaged),
          catch: asError,
        }).pipe(
          Effect.timeoutOrElse({
            duration: "20 seconds",
            orElse: () => Effect.fail(new Error("Checking for updates timed out. Try again.")),
          }),
        );
        return {
          fromVersion,
          desktopManaged,
          targetVersion,
          updatePolicy: descriptor.updatePolicy,
        } satisfies EnvironmentReleaseCheck;
      }),
  ).pipe(Atom.withLabel(`mobile:environment-release-check:${environmentId}`)),
);

export function releaseCheckValue(
  result: AsyncResult.AsyncResult<EnvironmentReleaseCheck, Error>,
): EnvironmentReleaseCheck | null {
  return AsyncResult.getOrElse(result, () => null);
}

export function releaseCheckError(
  result: AsyncResult.AsyncResult<EnvironmentReleaseCheck, Error>,
): string | null {
  if (!AsyncResult.isFailure(result) || result.waiting) return null;
  return Option.getOrNull(AsyncResult.error(result))?.message ?? null;
}
