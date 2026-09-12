/**
 * Spawns `cmd` in headless NDJSON mode and turns its event stream into ACP
 * session updates.
 *
 * `cmd -p` is one-shot: every ACP prompt is a fresh process resumed onto the
 * same Command Code session id, which is how multi-turn context survives.
 */

import { spawn } from "node:child_process";
import { createLineSplitter, mapCmdEvent, unwrapCmdLine } from "./map-events.mjs";

/**
 * Build the argv for one headless `cmd` run.
 *
 * @param {object} o
 * @param {string} [o.cmdSessionId] resume target, absent on the first turn
 * @param {boolean} o.allowWrites `--yolo`; cmd's headless mode has no
 *   interactive permission channel, so this is all-or-nothing (see README).
 * @param {string} [o.model]
 * @param {string} [o.effort]
 */
export function buildCmdArgs({ cmdSessionId, allowWrites, model, effort }) {
  const args = ["-p", "--output-format", "json", "--skip-onboarding", "--no-auto-update"];
  if (allowWrites) args.push("--yolo", "--tools-all");
  if (cmdSessionId) args.push("--resume", cmdSessionId);
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  return args;
}

/** Flatten an ACP prompt (text blocks + resource links) into one cmd prompt. */
export function flattenPrompt(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) => {
      if (block?.type === "text" && typeof block.text === "string") return block.text;
      if (block?.type === "resource_link" && typeof block.uri === "string") return `@${block.uri}`;
      if (block?.type === "resource" && typeof block.resource?.text === "string") {
        return block.resource.text;
      }
      return "";
    })
    .filter((part) => part !== "")
    .join("\n\n");
}

/**
 * Run one turn. Resolves `{ stopReason, cmdSessionId }`.
 *
 * @param {object} o
 * @param {(update: object) => void} o.onUpdate
 * @param {(line: string) => void} [o.onLog] raw stderr, for diagnostics
 */
export function runCmdTurn({
  executable = "cmd",
  args,
  cwd,
  env,
  prompt,
  signal,
  onUpdate,
  onLog,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const splitter = createLineSplitter();
    let cmdSessionId;
    let stopReason;
    let cancelled = false;
    let stderr = "";

    const abort = () => {
      cancelled = true;
      child.kill("SIGTERM");
    };
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }

    const consume = (line) => {
      const event = unwrapCmdLine(line);
      if (event === undefined) return;
      if (event.type === "run_start" && typeof event.sessionId === "string") {
        cmdSessionId = event.sessionId;
      }
      if (event.type === "result" && typeof event.sessionId === "string") {
        cmdSessionId = event.sessionId;
      }
      const { updates, stopReason: reason } = mapCmdEvent(event);
      for (const update of updates) onUpdate(update);
      if (reason !== undefined) stopReason = reason;
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text) => {
      for (const line of splitter.push(text)) consume(line);
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text) => {
      stderr += text;
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
      onLog?.(text);
    });

    child.on("error", (error) => {
      signal?.removeEventListener("abort", abort);
      reject(
        error.code === "ENOENT"
          ? new Error(
              `Command Code executable "${executable}" not found on PATH. Install it with \`npm i -g command-code\`.`,
            )
          : error,
      );
    });

    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      for (const line of splitter.flush()) consume(line);
      if (cancelled) return resolve({ stopReason: "cancelled", cmdSessionId });
      if (code !== 0 && stopReason === undefined) {
        return reject(new Error(`cmd exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
      }
      resolve({ stopReason: stopReason ?? "end_turn", cmdSessionId });
    });

    child.stdin.end(prompt);
  });
}
