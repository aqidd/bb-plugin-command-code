/**
 * Model catalog for ACP session config options: models from `cmd
 * --list-models`, per-model reasoning efforts from the model doc cmd bundles.
 */

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";

// eslint-disable-next-line no-control-regex -- stripping real ANSI SGR sequences
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * A model row is an id, a column gap, then a description. The gap is what
 * separates rows from section headings ("xAI") and footer prose, which are
 * single-spaced. Ids are bare for first-party models (`claude-sonnet-5`) and
 * namespaced for the rest (`z-ai/glm-5.3-flash`).
 */
const MODEL_ROW = /^([A-Za-z0-9][\w.:]*(?:[-/][\w.:]+)+)\s{2,}(.+)$/;

/** @returns {{id: string, description: string, isDefault: boolean}[]} */
export function parseCmdModelTable(stdout) {
  const models = [];
  const seen = new Set();
  for (const raw of String(stdout).split("\n")) {
    const line = raw.replace(ANSI, "").trimEnd();
    const match = MODEL_ROW.exec(line.trim());
    if (!match) continue;
    const [, id, rest = ""] = match;
    if (seen.has(id)) continue;
    seen.add(id);
    const description = rest.trim();
    models.push({
      id,
      description: description.replace(/\s*\((?:default|recommended)\)\s*$/, "").trim(),
      isDefault: /\((?:default|recommended)\)\s*$/.test(description),
    });
  }
  return models;
}

/**
 * BB renders the config option name as the model's name in its picker, and
 * cmd's descriptions are marketing taglines ("fast hybrid-attention
 * reasoning"), not names. Derive a plain name from the id:
 * "z-ai/glm-5.3-flash" -> "GLM 5.3 Flash", "claude-sonnet-5" -> "Claude Sonnet 5".
 */
const ACRONYMS = new Set(["ai", "glm", "gpt"]);

export function modelNameFromId(id) {
  const local = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return local
    .split(/[-_:]/)
    .map((word) => {
      if (!word) return word;
      if (ACRONYMS.has(word)) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

/** `| \`id\` | Name | Context | Efforts | ...` rows of cmd's models.md. */
const EFFORT_ROW = /^\|\s*`([^`]+)`\s*\|[^|]*\|[^|]*\|([^|]*)\|/;
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

/**
 * cmd exits 1 on an effort a model does not support, and ids differ in case
 * between `--list-models` and the doc, so keys are lowercased. Models whose
 * efforts cell is "—" pick their own depth and get no entry.
 *
 * @returns {Map<string, string[]>}
 */
export function parseCmdEffortTable(markdown) {
  const efforts = new Map();
  for (const line of String(markdown).split("\n")) {
    const match = EFFORT_ROW.exec(line);
    if (!match) continue;
    const levels = match[2].split(",").map((level) => level.trim()).filter((level) => EFFORT_LEVELS.has(level));
    if (levels.length > 0) efforts.set(match[1].toLowerCase(), levels);
  }
  return efforts;
}

// ponytail: cmd publishes no per-model default effort; high sits in all but one ladder.
function pickEffort(levels, effort) {
  if (levels.includes(effort)) return effort;
  return ["high", "medium"].find((level) => levels.includes(level)) ?? levels[0];
}

/**
 * ACP config options BB reads per model: a `model` select, plus a
 * `thought_level` select holding only the selected model's efforts.
 */
export function buildConfigOptions(models, efforts, { model, effort } = {}) {
  if (models.length === 0) return [];
  const current = model ?? models.find((m) => m.isDefault)?.id ?? models[0].id;
  const options = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: current,
      options: models.map(({ id }) => ({ value: id, name: modelNameFromId(id) })),
    },
  ];
  const levels = efforts.get(current.toLowerCase());
  if (levels !== undefined) {
    options.push({
      id: "effort",
      name: "Reasoning effort",
      category: "thought_level",
      type: "select",
      currentValue: pickEffort(levels, effort),
      options: levels.map((level) => ({ value: level, name: level })),
    });
  }
  return options;
}

/** Applies `session/set_config_option` to a session record. */
export function applyConfigOption(record, configId, value, efforts) {
  if (configId === "effort") return { ...record, effort: value };
  if (configId !== "model") throw new Error(`Unknown config option "${configId}"`);
  const keepsEffort = efforts.get(value.toLowerCase())?.includes(record.effort) === true;
  return { ...record, model: value, effort: keepsEffort ? record.effort : undefined };
}

export function runCmdListModels(executable = "cmd") {
  return new Promise((resolve, reject) => {
    execFile(executable, ["--list-models"], { timeout: 30_000 }, (error, stdout) => {
      if (error && !stdout) reject(error);
      else resolve(stdout ?? "");
    });
  });
}

async function findOnPath(name) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error(`${name} not on PATH`);
}

// ponytail: reads cmd's bundled, generated models.md; if a cmd release moves it, efforts vanish and models run at their own default.
async function readCmdModelsDoc(executable) {
  try {
    const bin = executable.includes("/") ? executable : await findOnPath(executable);
    const dist = dirname(await realpath(bin));
    return await readFile(join(dist, "bundled", "command-code-knowledge", "reference", "models.md"), "utf8");
  } catch {
    return "";
  }
}

export async function loadCmdCatalog(executable = "cmd") {
  const [table, doc] = await Promise.all([runCmdListModels(executable), readCmdModelsDoc(executable)]);
  return { models: parseCmdModelTable(table), efforts: parseCmdEffortTable(doc) };
}
