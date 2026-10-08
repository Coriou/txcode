// Fork-local: retain an OMP native session only within its original provider instance.
import {
  ProviderDriverKind,
  ProviderInstanceId,
  TrimmedNonEmptyString,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { deriveProviderThread } from "@t3tools/provider-core/server/IdAllocator";

const decodeBinding = Schema.decodeUnknownOption(
  Schema.Struct({
    omp_provider_name: Schema.Literal("omp"),
    omp_provider_instance_id: ProviderInstanceId,
    omp_adapter_key: Schema.Literal("omp"),
    omp_resume_cursor_json: Schema.fromJsonString(
      Schema.Struct({
        schemaVersion: Schema.Literal(1),
        sessionId: TrimmedNonEmptyString,
      }),
    ),
  }),
);

/** Importing this reference never opens a provider or sends conversation history. */
export function ompLegacyProviderThread(
  thread: OrchestrationV2AppThread,
  binding: unknown,
): OrchestrationV2ProviderThread | undefined {
  const decoded = decodeBinding(binding);
  if (
    Option.isNone(decoded) ||
    decoded.value.omp_provider_instance_id !== thread.providerInstanceId
  ) {
    return undefined;
  }
  const driver = ProviderDriverKind.make("omp");
  const nativeId = decoded.value.omp_resume_cursor_json.sessionId;
  return {
    id: deriveProviderThread({
      driver,
      providerInstanceId: thread.providerInstanceId,
      nativeThreadId: nativeId,
    }),
    driver,
    providerInstanceId: thread.providerInstanceId,
    providerSessionId: null,
    appThreadId: thread.id,
    ownerNodeId: null,
    nativeThreadRef: { driver, nativeId, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "not_loaded",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    contextUsage: null,
    nativeMetadata: null,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}
