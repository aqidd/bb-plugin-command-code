/**
 * `cmd --list-models` prints an aligned, ANSI-coloured table grouped by
 * section. BB's ACP bridge parses `<id> - <description>` lines, so the
 * adapter re-emits the table in that shape.
 */

import { execFile } from "node:child_process";

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
 * Render for BB's `MODEL_LINE_PATTERN` (`/^(\S+) - (.+)$/`).
 *
 * The line format carries no default marker and BB treats the first row as
 * the default, so cmd's own default is hoisted to the front.
 */
export function formatModelLines(models) {
  const ordered = [...models].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  return ordered.map(({ id, description }) => `${id} - ${description || id}`).join("\n");
}

export function runCmdListModels(executable = "cmd") {
  return new Promise((resolve, reject) => {
    execFile(executable, ["--list-models"], { timeout: 30_000 }, (error, stdout) => {
      if (error && !stdout) reject(error);
      else resolve(stdout ?? "");
    });
  });
}
