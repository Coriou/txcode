import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, type ProviderReplayTranscript } from "@t3tools/contracts";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

import { materializeReplayTranscriptRuntimeInstructions } from "./ReplayRuntimeInstructions.ts";

const switchedModelRuntimeInfo = [
  "<runtime_info>In case you're asked: you are running in T3 Code through the Kiro harness, as claude-sonnet-4.5. No need to mention this otherwise. You can embed images, video, and audio in your response using Markdown image syntax with absolute file paths. Link any other file you produce using its absolute path so the user can open it in T3 Code's files viewer.</runtime_info>",
  "",
  "<pull_request_linking>",
  "<any>",
  "</pull_request_linking>",
  "",
  "## T3 Code orchestration",
].join("\n");

function promptTranscript(parts: ReadonlyArray<string>): ProviderReplayTranscript {
  return {
    provider: "kiro",
    protocol: "acp.ndjson-jsonrpc",
    version: "1",
    scenario: "kiro_model_switch",
    entries: [
      {
        type: "expect_outbound",
        frame: {
          method: "session/prompt",
          params: { prompt: parts.map((text) => ({ type: "text", text })) },
        },
      },
    ],
  };
}

function promptParts(transcript: ProviderReplayTranscript): ReadonlyArray<string> {
  const entry = transcript.entries[0];
  if (entry === undefined || entry.type === "runtime_exit") {
    throw new Error("expected a prompt frame");
  }
  const frame = entry.frame as {
    readonly params: { readonly prompt: ReadonlyArray<{ readonly text: string }> };
  };
  return frame.params.prompt.map((part) => part.text);
}

it("aligns a recorded runtime_info product name and keeps the switched model", () => {
  const result = materializeReplayTranscriptRuntimeInstructions(
    promptTranscript([
      "## T3 Code interaction mode: Default\n\nRespond with exactly: kiro model switch second",
      switchedModelRuntimeInfo,
    ]),
    { driver: ProviderDriverKind.make("kiro"), model: "claude-haiku-4.5" },
  );
  const [userText, runtimeText] = promptParts(result);
  const current = buildRuntimeInstructions({ harness: "Kiro", model: "claude-sonnet-4.5" });
  const runtimeInfo = current.slice(
    0,
    current.indexOf("</runtime_info>") + "</runtime_info>".length,
  );
  expect(runtimeText?.startsWith(runtimeInfo)).toBe(true);
  expect(runtimeText).not.toContain("claude-haiku-4.5");
  expect(runtimeText).toContain("as claude-sonnet-4.5");
  expect(runtimeText).toContain("<pull_request_linking>\n<any>\n</pull_request_linking>");
  expect(runtimeText).toContain("## T3 Code orchestration");
  expect(userText).toContain("## T3 Code interaction mode");
});

it("appends current instructions when the prompt has no recorded runtime_info", () => {
  const instructions = buildRuntimeInstructions({ harness: "Kiro", model: "claude-haiku-4.5" });
  const result = materializeReplayTranscriptRuntimeInstructions(
    promptTranscript(["Respond with exactly: kiro model switch first"]),
    { driver: ProviderDriverKind.make("kiro"), model: "claude-haiku-4.5" },
  );
  expect(promptParts(result)).toEqual([
    "Respond with exactly: kiro model switch first",
    instructions,
  ]);
});
