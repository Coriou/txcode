// Fork-local: upstream has no Oh My Pi provider; this mirrors provider-pi's reader for OMP's format.
import type { OmpSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { ompProfileFromLaunchArgs } from "../acp/OmpAcpSupport.ts";
import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as HostProcess from "@t3tools/shared/HostProcess";

const OmpScanState = Schema.Struct({ sessionId: Schema.mutableKey(Schema.String) });
const Usage = Schema.Struct({
  input: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.Unknown),
  cacheRead: Schema.optional(Schema.Unknown),
  cacheWrite: Schema.optional(Schema.Unknown),
  reasoningTokens: Schema.optional(Schema.Unknown),
  cost: Schema.optional(Schema.Struct({ total: Schema.Unknown })),
});
const Entry = Schema.Union([
  Schema.Struct({ type: Schema.Literal("session"), id: Schema.NonEmptyString }),
  Schema.Struct({
    type: Schema.Literal("message"),
    id: Schema.NonEmptyString,
    timestamp: Schema.String,
    message: Schema.Struct({
      role: Schema.Literal("assistant"),
      provider: Schema.NonEmptyString,
      model: Schema.NonEmptyString,
      usage: Usage,
    }),
  }),
]);
const decodeEntry = Schema.decodeUnknownOption(Entry);

function parseRecord(parsed: unknown, state: typeof OmpScanState.Type): readonly UsageRecord[] {
  const decoded = decodeEntry(parsed);
  if (Option.isNone(decoded)) return [];
  const entry = decoded.value;
  if (entry.type === "session") {
    // Subagent sessions live in their own file with their own header, so each counts as its own session.
    state.sessionId = entry.id;
    return [];
  }
  const timestampMs = parseTimestampMs(entry.timestamp);
  if (timestampMs === null) return [];
  const usage = entry.message.usage;
  const model = `${entry.message.provider}/${entry.message.model}`;
  const totals = {
    uncachedInputTokens: tokenCount(usage.input),
    cachedInputTokens: tokenCount(usage.cacheRead),
    cacheCreationTokens: tokenCount(usage.cacheWrite),
    outputTokens: tokenCount(usage.output),
    reasoningTokens: tokenCount(usage.reasoningTokens),
  };
  const cost = usage.cost?.total;
  // Zero cost means OMP had no price for the model; let T3 estimate instead of recording free usage.
  const reportedCostUsd =
    typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null;
  if (totalTokens(totals) === 0 && reportedCostUsd === null) return [];
  return [
    {
      provider: "omp",
      timestampMs,
      model,
      // Pricing tables key on the bare model id OMP stores, not the provider-prefixed display id.
      rateModel: entry.message.model,
      sessionId: state.sessionId,
      totals,
      reportedCostUsd,
      speed: "standard",
      // Copies keep ids and timestamps, so this collapses a fork's copied entries; timestamp and model separate unrelated sessions.
      dedupeKey: JSON.stringify(["omp", entry.id, entry.timestamp, model]),
    },
  ];
}

export const ompUsageFormat: TranscriptUsageFormat<typeof OmpScanState.Type> = {
  selectFields: {
    type: true,
    id: true,
    timestamp: true,
    message: { role: true, provider: true, model: true, usage: true },
  },
  usageMarkers: ['"usage"', '"session"'],
  parseLine: (line, state) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    return parseRecord(parsed, state);
  },
  parseProjected: parseRecord,
  state: { initial: () => ({ sessionId: "" }), schema: OmpScanState },
};

export type OmpUsageEnv = Path.Path | FileSystem.FileSystem;

const PROFILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WINDOWS_RESERVED_PROFILE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;

/** Empty, `default`, and names OMP rejects all fall back to the default profile instead of failing a scan. */
function profileName(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || normalized === "default") return undefined;
  if (!PROFILE_NAME.test(normalized) || normalized.endsWith(".")) return undefined;
  return WINDOWS_RESERVED_PROFILE.test(normalized) ? undefined : normalized;
}

function sessionDirFromLaunchArgs(launchArgs: string | undefined): string | undefined {
  const args = tokenizeCliArgs(launchArgs);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg.startsWith("--session-dir=")) {
      const value = arg.slice("--session-dir=".length).trim();
      if (value.length > 0) return value;
      continue;
    }
    if (arg === "--session-dir") {
      const value = (args[index + 1] ?? "").trim();
      if (value.length > 0 && !value.startsWith("-")) return value;
    }
  }
  return undefined;
}

/** Declared apart from the reader so tests can exercise store resolution without narrowing a union. */
export const ompUsageDirectories = Effect.fn("ompUsageReader.directories")(function* (input: {
  readonly config: OmpSettings | undefined;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const { config, environment } = input;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const home = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  const resolve = (value: string) => path.resolve(expandHomePath(value, home));
  const exists = (dir: string) => fileSystem.exists(dir).pipe(Effect.orElseSucceed(() => false));

  // OMP's own precedence: launch flags, session-dir env, profile, agent dir, XDG, then the config root.
  const launchSessionDir = sessionDirFromLaunchArgs(config?.launchArgs);
  if (launchSessionDir !== undefined) return [{ dir: resolve(launchSessionDir) }];
  const sessionDir = environment.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (sessionDir) return [{ dir: resolve(sessionDir) }];

  const configRoot = path.join(home, environment.PI_CONFIG_DIR?.trim() || ".omp");
  // `--profile default` on the command line outranks the env, so it must not fall through to OMP_PROFILE.
  const launchProfile = ompProfileFromLaunchArgs(config?.launchArgs ?? undefined);
  const profile =
    launchProfile !== undefined
      ? profileName(launchProfile)
      : profileName(
          environment.OMP_PROFILE !== undefined ? environment.OMP_PROFILE : environment.PI_PROFILE,
        );
  // XDG is a linux/macOS convention and applies only once OMP created its XDG root.
  const xdgData =
    platform === "linux" || platform === "darwin" ? environment.XDG_DATA_HOME?.trim() : undefined;

  if (profile) {
    if (xdgData) {
      const xdgProfileRoot = path.join(resolve(xdgData), "omp", "profiles", profile);
      if (yield* exists(xdgProfileRoot)) return [{ dir: path.join(xdgProfileRoot, "sessions") }];
    }
    return [{ dir: path.join(configRoot, "profiles", profile, "agent", "sessions") }];
  }
  const agentDir = environment.PI_CODING_AGENT_DIR?.trim();
  if (agentDir) return [{ dir: path.join(resolve(agentDir), "sessions") }];
  if (xdgData) {
    const xdgRoot = path.join(resolve(xdgData), "omp");
    if (yield* exists(xdgRoot)) return [{ dir: path.join(xdgRoot, "sessions") }];
  }
  return [{ dir: path.join(configRoot, "agent", "sessions") }];
});

export const ompUsageReader: ProviderUsageReader<OmpSettings, OmpUsageEnv> = {
  kind: "transcripts",
  provider: "omp",
  format: ompUsageFormat,
  directories: ompUsageDirectories,
};
