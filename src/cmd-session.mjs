/**
 * Spawns `cmd` in headless NDJSON mode and turns its event stream into ACP
 * session updates.
 *
 * `cmd -p` is one-shot: every ACP prompt is a fresh process resumed onto the
 * same Command Code session id, which is how multi-turn context survives.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** BB's text for an image it only has as a URL (http(s) or data:). */
const IMAGE_URL_ATTACHMENT = /\[image attachment: ((?:https?:\/\/|data:image\/)[^\]\s]+)\]/g;
const IMAGE_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
};
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * cmd -p takes text only and its read_file cannot open URLs, so image URLs
 * are saved to disk and rewritten to the on-disk form BB uses for local
 * images. A URL that fails to download, or is not an image, is left as-is.
 */
export async function localizeImageUrls(text, { dir = join(tmpdir(), "command-code-acp-images") } = {}) {
  let result = text;
  for (const url of new Set([...text.matchAll(IMAGE_URL_ATTACHMENT)].map((m) => m[1]))) {
    const path = await saveImage(url, dir).catch(() => undefined);
    if (path !== undefined) {
      result = result.replaceAll(`[image attachment: ${url}]`, `[image attachment on disk: ${path}]`);
    }
  }
  return result;
}

// ponytail: buffers the whole body before the size check and never deletes files; stream with a byte cap and clean up if large images show up.
async function saveImage(url, dir) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) return undefined;
  const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const extension = IMAGE_EXTENSIONS[type];
  if (extension === undefined) return undefined;
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) return undefined;
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${randomUUID()}.${extension}`);
  await writeFile(path, bytes);
  return path;
}

/**
 * Run one turn. Resolves `{ stopReason, cmdSessionId }`.
 *
 * @param {object} o
 * @param {(update: object) => void} o.onUpdate
 * @param {(line: string) => void} [o.onLog] raw stderr, for diagnostics
 * @param {Map<string, number>} [o.contexts] context window per model, for usage updates
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
  contexts,
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
      const { updates, stopReason: reason } = mapCmdEvent(event, contexts);
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
