// Fork-local OMP ACP v1 wire fixture. No provider credentials or model calls.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const log = (entry) => {
  if (process.env.OMP_WIRE_LOG)
    NodeFS.appendFileSync(process.env.OMP_WIRE_LOG, JSON.stringify(entry) + "\n");
};
log({ launchArgs: process.argv.slice(2), pid: process.pid });
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const result = (id, value) => send({ id, result: value });
const update = (sessionId, value) =>
  send({ method: "session/update", params: { sessionId, update: value } });
const text = (sessionId, value) =>
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: value },
  });
let model = "default";
let mode = "architect";
let thinking = "medium";
let sessionId = "omp-session";
let prompt;
const setup = () => ({
  sessionId,
  modes: {
    currentModeId: mode,
    availableModes: [
      { id: "architect", name: "Plan" },
      { id: "agent", name: "Implement" },
    ],
  },
  models: {
    currentModelId: model,
    availableModels: [
      { modelId: "default", name: "Default" },
      { modelId: "test-model", name: "Test" },
    ],
  },
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: model,
      options: [
        { value: "default", name: "Default" },
        { value: "test-model", name: "Test" },
      ],
    },
    {
      id: "thinking_level",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue: thinking,
      options: [
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    },
  ],
});
const finish = (stopReason = "end_turn", value = "hello from OMP") => {
  if (!prompt) return;
  const current = prompt;
  prompt = undefined;
  if (value) text(current.params.sessionId, value);
  result(current.id, { stopReason });
};
NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  log(msg);
  if (!msg.method) {
    if (msg.id === "omp-permission") finish("end_turn", JSON.stringify(msg.result));
    if (msg.id === "omp-elicitation") finish("end_turn", JSON.stringify(msg.result));
    return;
  }
  const params = msg.params ?? {};
  switch (msg.method) {
    case "initialize":
      result(msg.id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true },
          mcpCapabilities: { http: true },
        },
        agentInfo: { name: "omp", version: "18.1.19" },
        authMethods: [],
      });
      break;
    case "authenticate":
      result(msg.id, {});
      break;
    case "session/new":
      result(msg.id, setup());
      break;
    case "session/load":
      sessionId = params.sessionId;
      result(msg.id, setup());
      break;
    case "session/set_model":
      if (process.env.OMP_FAIL_MODEL === "1")
        send({ id: msg.id, error: { code: -32603, message: "OMP rejected model" } });
      else {
        model = params.modelId;
        result(msg.id, {});
      }
      break;
    case "session/set_config_option":
      if (process.env.OMP_FAIL_MODEL === "1" && params.configId === "model")
        send({ id: msg.id, error: { code: -32603, message: "OMP rejected model" } });
      else {
        if (params.configId === "model") model = params.value;
        if (params.configId === "thinking_level") thinking = params.value;
        result(msg.id, { configOptions: setup().configOptions });
      }
      break;
    case "session/set_mode":
      mode = params.modeId;
      result(msg.id, {});
      break;
    case "session/cancel":
      finish("cancelled", "");
      break;
    case "session/prompt":
      prompt = msg;
      if (process.env.OMP_EXIT_PROMPT === "1") {
        process.exit(9);
        break;
      }
      if (process.env.OMP_HANG_PROMPT === "1") {
        update(params.sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "omp-hanging",
          title: "Waiting",
          kind: "execute",
          status: "in_progress",
        });
        break;
      }
      if (process.env.OMP_PERMISSION) {
        const edit = process.env.OMP_PERMISSION === "edit";
        send({
          id: "omp-permission",
          method: "session/request_permission",
          params: {
            sessionId: params.sessionId,
            toolCall: {
              toolCallId: "omp-tool",
              title: edit ? "Edit file" : "Run command",
              kind: edit ? "edit" : "execute",
              ...(edit
                ? { locations: [{ path: "/tmp/project/file.ts" }] }
                : { rawInput: { command: "echo hello" } }),
            },
            options: [
              { optionId: "omp-allow-once", name: "Allow", kind: "allow_once" },
              { optionId: "omp-allow-always", name: "Always", kind: "allow_always" },
              { optionId: "omp-reject", name: "Reject", kind: "reject_once" },
            ],
          },
        });
        break;
      }
      if (process.env.OMP_ELICITATION === "1") {
        send({
          id: "omp-elicitation",
          method: "session/elicitation",
          params: {
            sessionId: params.sessionId,
            mode: "form",
            message: "Choose deployment",
            requestedSchema: {
              type: "object",
              properties: {
                target: {
                  type: "string",
                  title: "Where?",
                  oneOf: [
                    { const: "preview", title: "Preview" },
                    { const: "production", title: "Production" },
                  ],
                },
                target__other: { type: "string", title: "Other" },
                confirmed: { type: "boolean", title: "Continue?" },
                count: { type: "integer", title: "How many?" },
                regions: {
                  type: "array",
                  title: "Regions",
                  items: { type: "string", enum: ["eu", "us"] },
                },
              },
            },
          },
        });
        break;
      }
      finish("end_turn", process.env.OMP_SILENT === "1" ? "" : "hello from OMP");
      break;
    default:
      if (msg.id !== undefined) result(msg.id, {});
  }
});
