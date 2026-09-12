/**
 * Pure translation from Command Code's headless NDJSON events to ACP
 * `session/update` payloads.
 *
 * Kept free of I/O so the whole mapping is testable without spawning `cmd`.
 * Event names come from `cmd -p --output-format json` (Command Code 1.53.0).
 */

/** cmd tool name -> ACP tool kind. Checked longest-prefix first, then substring. */
const TOOL_KINDS = [
  ["read_file", "read"],
  ["read_many_files", "read"],
  ["notebook_read", "read"],
  ["write_file", "edit"],
  ["edit_file", "edit"],
  ["multi_edit", "edit"],
  ["apply_patch", "edit"],
  ["notebook_edit", "edit"],
  ["shell_command", "execute"],
  ["run_command", "execute"],
  ["list_files", "search"],
  ["glob", "search"],
  ["grep", "search"],
  ["search_files", "search"],
  ["codebase_search", "search"],
  ["web_fetch", "fetch"],
  ["web_search", "fetch"],
  ["delete_file", "delete"],
  ["move_file", "move"],
  ["todo_write", "think"],
  ["think", "think"],
];

/** @returns {"read"|"edit"|"execute"|"search"|"fetch"|"delete"|"move"|"think"|"other"} */
export function toolKind(toolName) {
  if (typeof toolName !== "string") return "other";
  const name = toolName.toLowerCase();
  for (const [needle, kind] of TOOL_KINDS) {
    if (name === needle) return kind;
  }
  for (const [needle, kind] of TOOL_KINDS) {
    if (name.includes(needle)) return kind;
  }
  if (name.includes("read") || name.includes("view")) return "read";
  if (name.includes("write") || name.includes("edit")) return "edit";
  if (name.includes("search") || name.includes("find")) return "search";
  return "other";
}

/** Best-effort human title for a tool call, mirroring what cmd shows in its TUI. */
export function toolTitle(toolName, input) {
  const arg = input && typeof input === "object" ? input : {};
  if (typeof arg.description === "string" && arg.description.trim() !== "") {
    return arg.description.trim();
  }
  if (typeof arg.command === "string") return arg.command;
  const path = filePathOf(arg);
  if (path !== undefined) return `${toolName} ${path}`;
  if (typeof arg.pattern === "string") return `${toolName} ${arg.pattern}`;
  if (typeof arg.url === "string") return arg.url;
  return toolName;
}

function filePathOf(arg) {
  for (const key of ["file_path", "filePath", "path", "target_file"]) {
    if (typeof arg?.[key] === "string") return arg[key];
  }
  return undefined;
}

/** ACP `locations`, so the client can link a tool call to files it touched. */
export function toolLocations(input) {
  const path = filePathOf(input);
  return path === undefined ? undefined : [{ path }];
}

/**
 * cmd reports tool output as an array of content blocks. ACP wants its own
 * content shape; anything non-text is dropped rather than guessed at.
 */
export function toolContent(blocks) {
  if (!Array.isArray(blocks)) return undefined;
  const content = blocks
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => ({ type: "content", content: { type: "text", text: b.text } }));
  return content.length > 0 ? content : undefined;
}

/** A write to a known path becomes an ACP diff so the client can render it. */
function writeDiff(toolName, input) {
  if (toolKind(toolName) !== "edit") return undefined;
  const path = filePathOf(input);
  const newText = input?.content ?? input?.new_string ?? input?.newText;
  const oldText = input?.old_string ?? input?.oldText;
  if (typeof path !== "string" || typeof newText !== "string") return undefined;
  return [
    {
      type: "diff",
      path,
      newText,
      ...(typeof oldText === "string" ? { oldText } : {}),
    },
  ];
}

/**
 * Translate one cmd event into zero or more ACP session updates.
 *
 * Returns `{ updates, stopReason? }`. A `stopReason` means the run is over.
 *
 * Deliberately ignores `message_update` / `message_end` / `thinking_end`:
 * those repeat the *cumulative* message, so forwarding them alongside the
 * `*_delta` events duplicates every word in the client.
 */
export function mapCmdEvent(event) {
  const none = { updates: [] };
  if (!event || typeof event.type !== "string") return none;

  switch (event.type) {
    case "text_delta":
      return chunk("agent_message_chunk", event.delta);

    case "thinking_delta":
      return chunk("agent_thought_chunk", event.delta);

    case "tool_queued":
      return {
        updates: [
          {
            sessionUpdate: "tool_call",
            toolCallId: event.toolCallId,
            title: toolTitle(event.toolName, event.input),
            kind: toolKind(event.toolName),
            status: "pending",
            rawInput: event.input,
            ...optional("locations", toolLocations(event.input)),
            ...optional("content", writeDiff(event.toolName, event.input)),
          },
        ],
      };

    case "tool_running":
      return {
        updates: [
          {
            sessionUpdate: "tool_call_update",
            toolCallId: event.toolCallId,
            status: "in_progress",
          },
        ],
      };

    case "tool_update":
      return {
        updates: [
          {
            sessionUpdate: "tool_call_update",
            toolCallId: event.toolCallId,
            status: "in_progress",
            ...optional("content", toolContent(event.partial)),
          },
        ],
      };

    case "tool_completed":
      return {
        updates: [
          {
            sessionUpdate: "tool_call_update",
            toolCallId: event.toolCallId,
            status: "completed",
            rawOutput: event.result,
            ...optional("content", toolContent(event.result)),
          },
        ],
      };

    case "tool_errored":
    case "tool_denied":
    case "tool_hook_blocked":
      return {
        updates: [
          {
            sessionUpdate: "tool_call_update",
            toolCallId: event.toolCallId,
            status: "failed",
            ...optional("content", failureContent(event)),
          },
        ],
      };

    case "run_end":
      return { updates: [], stopReason: stopReasonOf(event.result?.stopReason) };

    default:
      return none;
  }
}

function chunk(sessionUpdate, text) {
  if (typeof text !== "string" || text === "") return { updates: [] };
  return {
    updates: [{ sessionUpdate, content: { type: "text", text } }],
  };
}

function failureContent(event) {
  const text =
    event.hookOutput ??
    event.error ??
    event.reason ??
    `Tool ${event.toolName ?? "call"} did not complete.`;
  if (typeof text !== "string") return undefined;
  return [{ type: "content", content: { type: "text", text } }];
}

/** cmd stop reasons -> ACP stop reasons. */
function stopReasonOf(reason) {
  switch (reason) {
    case "interrupted":
    case "cancelled":
      return "cancelled";
    case "max_turns":
    case "max_tokens":
      return "max_turn_requests";
    case "refusal":
      return "refusal";
    default:
      return "end_turn";
  }
}

function optional(key, value) {
  return value === undefined ? {} : { [key]: value };
}

/**
 * Incremental NDJSON splitter. cmd writes one JSON object per line, but a
 * chunk boundary can land mid-line, so the tail is carried to the next call.
 */
export function createLineSplitter() {
  let buffer = "";
  return {
    push(text) {
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      return lines.filter((line) => line.trim() !== "");
    },
    flush() {
      const rest = buffer.trim();
      buffer = "";
      return rest === "" ? [] : [rest];
    },
  };
}

/** cmd wraps events as `{type:"event",event:{...}}`; `result` arrives bare. */
export function unwrapCmdLine(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (parsed?.type === "event" && parsed.event) return parsed.event;
  if (parsed?.type === "result") return { type: "result", ...parsed };
  return undefined;
}
