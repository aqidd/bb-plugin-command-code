import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCmdContextTable } from "../src/list-models.mjs";
import { mapCmdEvent } from "../src/map-events.mjs";

const DOC = [
  "| Id (use EXACTLY this) | Name | Context | Efforts | $/1M in/out · cache read | Min plan | Best for |",
  "|---|---|---|---|---|---|---|",
  "| `z-ai/glm-5.3-flash` | GLM-5.3 Flash | 1.05M | low, high, max | $0.15/$0.5 | Go and above | fast |",
  "| `moonshotai/Kimi-K2.6` | Kimi K2.6 | 256K | — | $0.95/$4 | Go and above | vision |",
  "| `zai-org/GLM-5.1` | GLM-5.1 | — | — | $1.4/$4.4 | Go and above | agent |",
].join("\n");

const CONTEXTS = parseCmdContextTable(DOC);

test("cmd's model doc yields context windows in tokens, keyed case-insensitively", () => {
  assert.equal(CONTEXTS.get("z-ai/glm-5.3-flash"), 1_050_000);
  assert.equal(CONTEXTS.get("moonshotai/kimi-k2.6"), 256_000);
  // "—" is an unknown window: no meter rather than a wrong one.
  assert.equal(CONTEXTS.has("zai-org/glm-5.1"), false);
});

test("a finished model request becomes an ACP usage_update for BB's context meter", () => {
  const event = {
    type: "model_request_end",
    model: "z-ai/glm-5.3-flash",
    usage: { inputTokens: 19301, outputTokens: 270, cacheReadTokens: 6080, cacheWriteTokens: 0 },
  };
  // cmd counts context as the request's input plus the reply it just added.
  assert.deepEqual(mapCmdEvent(event, CONTEXTS).updates, [
    { sessionUpdate: "usage_update", used: 19571, size: 1_050_000 },
  ]);
});

test("no meter when the model's window is unknown or usage is missing", () => {
  const usage = { inputTokens: 10, outputTokens: 1 };
  assert.deepEqual(mapCmdEvent({ type: "model_request_end", model: "zai-org/glm-5.1", usage }, CONTEXTS).updates, []);
  assert.deepEqual(mapCmdEvent({ type: "model_request_end", model: "z-ai/glm-5.3-flash" }, CONTEXTS).updates, []);
  assert.deepEqual(mapCmdEvent({ type: "model_request_end", model: "z-ai/glm-5.3-flash", usage }).updates, []);
});
