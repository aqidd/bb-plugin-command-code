import assert from "node:assert/strict";
import { test } from "node:test";

import { applyConfigOption, buildConfigOptions, parseCmdEffortTable } from "../src/list-models.mjs";

const DOC = [
  "| Id (use EXACTLY this) | Name | Context | Efforts | $/1M in/out · cache read | Min plan | Best for |",
  "|---|---|---|---|---|---|---|",
  "| `z-ai/glm-5.3-flash` | GLM-5.3 Flash | 1.05M | low, high, max | $0.15/$0.5 | Go and above | fast |",
  "| `zai-org/GLM-5.3` | GLM-5.3 | 1M | low, high, max | $1.4/$4.4 | Go and above | frontier |",
  "| `moonshotai/Kimi-K2.6` | Kimi K2.6 | 256K | — | $0.95/$4 | Go and above | vision |",
].join("\n");

const MODELS = [
  { id: "deepseek/deepseek-v4-flash", description: "", isDefault: true },
  { id: "z-ai/glm-5.3-flash", description: "", isDefault: false },
  { id: "zai-org/glm-5.3", description: "", isDefault: false },
  { id: "moonshotai/kimi-k2.6", description: "", isDefault: false },
];

const EFFORTS = parseCmdEffortTable(DOC);
const thought = (options) => options.find((o) => o.category === "thought_level");

test("cmd's model doc yields per-model efforts, keyed case-insensitively", () => {
  assert.deepEqual(EFFORTS.get("z-ai/glm-5.3-flash"), ["low", "high", "max"]);
  // --list-models prints zai-org/glm-5.3; the doc spells it zai-org/GLM-5.3.
  assert.deepEqual(EFFORTS.get("zai-org/glm-5.3"), ["low", "high", "max"]);
  // "—" means the model decides its own depth: no effort to offer.
  assert.equal(EFFORTS.has("moonshotai/kimi-k2.6"), false);
});

test("the model select defaults to cmd's own default model", () => {
  const [model] = buildConfigOptions(MODELS, EFFORTS, {});
  assert.equal(model.category, "model");
  assert.equal(model.currentValue, "deepseek/deepseek-v4-flash");
  assert.deepEqual(model.options[1], { value: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash" });
});

test("the thought_level select lists exactly the selected model's efforts", () => {
  const options = buildConfigOptions(MODELS, EFFORTS, { model: "z-ai/glm-5.3-flash", effort: "max" });
  assert.deepEqual(thought(options).options.map((o) => o.value), ["low", "high", "max"]);
  assert.equal(thought(options).currentValue, "max");
});

test("a model without declared efforts gets no thought_level select", () => {
  assert.equal(thought(buildConfigOptions(MODELS, EFFORTS, { model: "moonshotai/kimi-k2.6" })), undefined);
});

test("an unset or unsupported effort falls back to high, never cmd-rejected medium", () => {
  const options = buildConfigOptions(MODELS, EFFORTS, { model: "z-ai/glm-5.3-flash", effort: "medium" });
  assert.equal(thought(options).currentValue, "high");
});

test("switching model drops an effort the new model does not support", () => {
  const record = applyConfigOption({ model: "z-ai/glm-5.3-flash", effort: "max" }, "model", "moonshotai/kimi-k2.6", EFFORTS);
  assert.deepEqual(record, { model: "moonshotai/kimi-k2.6", effort: undefined });
  assert.deepEqual(
    applyConfigOption({ model: "z-ai/glm-5.3-flash", effort: "max" }, "model", "zai-org/glm-5.3", EFFORTS),
    { model: "zai-org/glm-5.3", effort: "max" },
  );
  assert.deepEqual(applyConfigOption({ model: "zai-org/glm-5.3" }, "effort", "low", EFFORTS), {
    model: "zai-org/glm-5.3",
    effort: "low",
  });
});
