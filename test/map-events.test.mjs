import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createLineSplitter,
  mapCmdEvent,
  toolKind,
  unwrapCmdLine,
} from "../src/map-events.mjs";
import { buildCmdArgs, flattenPrompt } from "../src/cmd-session.mjs";
import { formatModelLines, parseCmdModelTable } from "../src/list-models.mjs";

test("text and thinking deltas become their own ACP chunk kinds", () => {
  assert.deepEqual(mapCmdEvent({ type: "text_delta", delta: "pong" }).updates, [
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pong" } },
  ]);
  assert.deepEqual(mapCmdEvent({ type: "thinking_delta", delta: "hm" }).updates, [
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hm" } },
  ]);
});

test("cumulative events are dropped so the final message is not sent twice", () => {
  // cmd emits message_update/message_end carrying the WHOLE message so far;
  // forwarding them next to text_delta duplicates every word in the client.
  const content = [{ type: "text", text: "pong" }];
  assert.deepEqual(mapCmdEvent({ type: "message_update", content }).updates, []);
  assert.deepEqual(mapCmdEvent({ type: "message_end", content }).updates, []);
  assert.deepEqual(mapCmdEvent({ type: "thinking_end", text: "hm" }).updates, []);
});

test("a tool call runs pending -> in_progress -> completed", () => {
  const queued = mapCmdEvent({
    type: "tool_queued",
    toolCallId: "call_1",
    toolName: "shell_command",
    input: { command: "echo hi", description: "Echo hi" },
  }).updates[0];
  assert.equal(queued.sessionUpdate, "tool_call");
  assert.equal(queued.status, "pending");
  assert.equal(queued.kind, "execute");
  assert.equal(queued.title, "Echo hi");

  const running = mapCmdEvent({ type: "tool_running", toolCallId: "call_1" }).updates[0];
  assert.equal(running.sessionUpdate, "tool_call_update");
  assert.equal(running.status, "in_progress");

  const done = mapCmdEvent({
    type: "tool_completed",
    toolCallId: "call_1",
    result: [{ type: "text", text: "hi\n" }],
  }).updates[0];
  assert.equal(done.status, "completed");
  assert.deepEqual(done.content, [{ type: "content", content: { type: "text", text: "hi\n" } }]);
});

test("a read tool reports the file it touched", () => {
  const update = mapCmdEvent({
    type: "tool_queued",
    toolCallId: "call_2",
    toolName: "read_file",
    input: { file_path: "/tmp/sample.txt" },
  }).updates[0];
  assert.equal(update.kind, "read");
  assert.deepEqual(update.locations, [{ path: "/tmp/sample.txt" }]);
});

test("a write tool carries a diff the client can render", () => {
  const update = mapCmdEvent({
    type: "tool_queued",
    toolCallId: "call_3",
    toolName: "write_file",
    input: { file_path: "/tmp/a.txt", content: "next" },
  }).updates[0];
  assert.equal(update.kind, "edit");
  assert.deepEqual(update.content, [{ type: "diff", path: "/tmp/a.txt", newText: "next" }]);
});

test("a blocked tool fails the call instead of leaving it spinning", () => {
  const update = mapCmdEvent({
    type: "tool_hook_blocked",
    toolCallId: "call_4",
    toolName: "shell_command",
    hookOutput: 'Error: Tool "shell_command" requires permissions.',
  }).updates[0];
  assert.equal(update.status, "failed");
  assert.match(update.content[0].content.text, /requires permissions/);
});

test("run_end reports a stop reason", () => {
  assert.equal(mapCmdEvent({ type: "run_end", result: { stopReason: "end_turn" } }).stopReason, "end_turn");
  assert.equal(mapCmdEvent({ type: "run_end", result: { stopReason: "interrupted" } }).stopReason, "cancelled");
});

test("unknown tools fall back to a sensible kind", () => {
  assert.equal(toolKind("grep"), "search");
  assert.equal(toolKind("web_fetch"), "fetch");
  assert.equal(toolKind("something_unheard_of"), "other");
  assert.equal(toolKind(undefined), "other");
});

test("the line splitter survives a chunk boundary mid-JSON", () => {
  const splitter = createLineSplitter();
  assert.deepEqual(splitter.push('{"a":1}\n{"b":'), ['{"a":1}']);
  assert.deepEqual(splitter.push('2}\n'), ['{"b":2}']);
  assert.deepEqual(splitter.flush(), []);
});

test("cmd event envelopes are unwrapped, junk is ignored", () => {
  assert.deepEqual(unwrapCmdLine('{"type":"event","event":{"type":"run_start","sessionId":"s1"}}'), {
    type: "run_start",
    sessionId: "s1",
  });
  assert.equal(unwrapCmdLine("not json"), undefined);
});

test("resume and permission flags reach cmd's argv", () => {
  const args = buildCmdArgs({ cmdSessionId: "s1", allowWrites: true, model: "zai-org/glm-5.3" });
  assert.ok(args.includes("--yolo") && args.includes("--tools-all"));
  assert.deepEqual(args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 2), ["--resume", "s1"]);
  assert.ok(!buildCmdArgs({ allowWrites: false }).includes("--yolo"));
});

test("prompt blocks flatten to one cmd prompt", () => {
  assert.equal(
    flattenPrompt([
      { type: "text", text: "fix this" },
      { type: "resource_link", uri: "file:///a.ts" },
    ]),
    "fix this\n\n@file:///a.ts",
  );
});

test("cmd's aligned model table is reformatted for BB's parser", () => {
  const table = [
    "Available models  ·  70 models",
    "",
    "Open Source",
    "",
    "deepseek/deepseek-v4-flash             fast hybrid-attention reasoning (default)",
    "z-ai/glm-5.3-flash                     fast, affordable GLM coding with 1M context",
  ].join("\n");

  const models = parseCmdModelTable(table);
  assert.deepEqual(models.map((m) => m.id), [
    "deepseek/deepseek-v4-flash",
    "z-ai/glm-5.3-flash",
  ]);
  assert.equal(models[0].isDefault, true);
  // BB's MODEL_LINE_PATTERN is /^(\S+) - (.+)$/.
  for (const line of formatModelLines(models).split("\n")) {
    assert.match(line, /^(\S+) - (.+)$/);
  }
});

test("cmd's own default model is rendered first, because BB takes row one", () => {
  const models = parseCmdModelTable(
    [
      "alpha/one    first model",
      "beta/two     second model (default)",
    ].join("\n"),
  );
  assert.equal(formatModelLines(models).split("\n")[0], "beta/two - second model");
});
