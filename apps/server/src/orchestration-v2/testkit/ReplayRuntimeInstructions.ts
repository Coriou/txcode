import type { ProviderDriverKind, ProviderReplayTranscript } from "@t3tools/contracts";

import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

export function materializeReplayTranscriptRuntimeInstructions(
  transcript: ProviderReplayTranscript,
  runtime: { readonly driver: ProviderDriverKind; readonly model: string },
): ProviderReplayTranscript {
  const harness =
    runtime.driver === "cursor"
      ? "Cursor"
      : runtime.driver === "grok"
        ? "Grok"
        : runtime.driver === "kiro"
          ? "Kiro"
          : runtime.driver === "acpRegistry"
            ? "acpRegistry"
            : runtime.driver === "fx"
              ? "fx"
              : undefined;
  if (harness === undefined) return transcript;
  const instructions = buildRuntimeInstructions({ harness, model: runtime.model });

  return {
    ...transcript,
    entries: transcript.entries.map((entry) => {
      if (entry.type !== "expect_outbound") return entry;
      const frame = entry.frame;
      if (typeof frame !== "object" || frame === null) return entry;
      if (
        runtime.driver === "cursor" &&
        "type" in frame &&
        frame.type === "run.start" &&
        "message" in frame &&
        typeof frame.message === "string"
      ) {
        return frame.message.endsWith(instructions)
          ? entry
          : { ...entry, frame: { ...frame, message: `${frame.message}\n\n${instructions}` } };
      }
      if (
        "method" in frame &&
        frame.method === "session/prompt" &&
        "params" in frame &&
        typeof frame.params === "object" &&
        frame.params !== null &&
        "prompt" in frame.params &&
        Array.isArray(frame.params.prompt)
      ) {
        const prompt: ReadonlyArray<unknown> = frame.params.prompt;
        const lastPart = prompt.at(-1);
        if (
          typeof lastPart === "object" &&
          lastPart !== null &&
          "type" in lastPart &&
          lastPart.type === "text" &&
          "text" in lastPart &&
          typeof lastPart.text === "string" &&
          (lastPart.text === instructions || lastPart.text.startsWith("<runtime_info>"))
        ) {
          // The recorded block already names the model that prompt ran on.
          // Align only the product name; leave the model and later sections.
          const text = alignRecordedRuntimeProduct(lastPart.text, instructions);
          return text === lastPart.text
            ? entry
            : {
                ...entry,
                frame: {
                  ...frame,
                  params: {
                    ...frame.params,
                    prompt: [...prompt.slice(0, -1), { ...lastPart, text }],
                  },
                },
              };
        }
        return {
          ...entry,
          frame: {
            ...frame,
            params: { ...frame.params, prompt: [...prompt, { type: "text", text: instructions }] },
          },
        };
      }
      return entry;
    }),
  };
}

// Recorded model-switch prompts name the model that ran. Only the product name
// follows the current build; headings outside runtime_info stay as recorded.
function alignRecordedRuntimeProduct(text: string, instructions: string): string {
  const product = /you are running in (.+?) through the /.exec(instructions)?.[1];
  if (product === undefined || !text.startsWith("<runtime_info>")) return text;
  const end = text.indexOf("</runtime_info>");
  if (end < 0) return text;
  const head = text.slice(0, end);
  const tail = text.slice(end);
  return (
    head
      .replace(
        /you are running in .+? through the /,
        () => `you are running in ${product} through the `,
      )
      .replace(/open it in .+?'s files viewer\./, () => `open it in ${product}'s files viewer.`) +
    tail
  );
}
