# bb-plugin-command-code

Run [Command Code](https://commandcode.ai/docs) (`cmd`) as a first-class agent provider inside [BB](https://github.com/get-bb/bb).

Command Code has no Agent Client Protocol server of its own, so this repo ships two things:

1. **`command-code-acp`** — an ACP agent that drives `cmd -p --output-format json`. Usable by any ACP client (BB, Zed, JetBrains, Neovim), not just BB.
2. **The BB plugin** — registers `command-code` as a provider and points BB's built-in ACP bridge at that adapter.

## Install

Both steps are needed: the plugin declares the provider, the adapter is what actually runs.

```bash
# 1. Command Code itself
npm i -g command-code

# 2. The ACP adapter (puts `command-code-acp` on PATH)
npm i -g github:aqidd/bb-plugin-command-code

# 3. The BB plugin
bb plugin install git:https://github.com/aqidd/bb-plugin-command-code
```

Then start a thread:

```bash
bb thread spawn --provider command-code --prompt "explain this repo"
```

The provider stays hidden in BB's picker until `command-code-acp` is on the machine's `PATH` (`experimental_visibility: "installed"`), so step 2 is not optional.

## Settings

Settings → Plugins → Command Code:

| Setting | Default | What it does |
|---|---|---|
| Allow file writes and shell commands | on | Runs `cmd` with `--yolo`. Off makes the provider read-only. |
| Command Code executable | empty | Path to `cmd` if it is not on `PATH`. |

## Permissions — read this before enabling writes

**`cmd -p` has no interactive permission channel.** Verified against Command Code 1.53.0: without `--yolo`, every write and shell tool is refused outright with

```
Error: Tool "shell_command" requires permissions. Use --yolo
(or --dangerously-skip-permissions) to enable file writes and shell
commands in print mode.
```

and with `--yolo` everything runs unsupervised. There is no third option, so **BB's per-tool approval prompts do not apply to this provider.** The choice is exposed once, as the setting above, rather than pretended per call.

If that is too coarse for your workspace, turn the setting off and use the provider for read-only review work.

Command Code does have a `PreToolUse` hook that can deny a call, which is the likely route to real per-call approval. It is not wired up here — see [open issues](https://github.com/aqidd/bb-plugin-command-code/issues).

## What the adapter maps

| Command Code event | ACP `session/update` |
|---|---|
| `text_delta` | `agent_message_chunk` |
| `thinking_delta` | `agent_thought_chunk` |
| `tool_queued` | `tool_call` (`pending`, with `kind`, `locations`, diff for writes) |
| `tool_running` | `tool_call_update` (`in_progress`) |
| `tool_update` | `tool_call_update` (streamed output) |
| `tool_completed` | `tool_call_update` (`completed`) |
| `tool_errored` / `tool_denied` / `tool_hook_blocked` | `tool_call_update` (`failed`) |
| `run_end` | prompt result `stopReason` |

`message_update`, `message_end` and `thinking_end` are deliberately ignored: they repeat the **cumulative** message, so forwarding them alongside the delta events duplicates every word.

Multi-turn context works by resuming: `cmd -p` is one-shot, so each ACP prompt spawns a fresh `cmd` resumed onto the same Command Code session id. The ACP-id → cmd-id pairing lives in `~/.command-code-acp/sessions.json` so `session/load` survives a restart.

Models and reasoning effort are ACP session config options: a `model` select from `cmd --list-models`, and a `thought_level` select holding only the selected model's `--effort` levels, read from the `models.md` cmd bundles (GLM 5.3 Flash: low, high, max). Models with no declared efforts run at their own default.

## Using the adapter without BB

```bash
command-code-acp            # ACP over stdio, read-only
command-code-acp --yolo     # allow writes and shell commands
command-code-acp --model zai-org/glm-5.3 --effort high
```

`COMMAND_CODE_EXECUTABLE` overrides which `cmd` binary is used.

## Development

```bash
npm install
npm test          # node:test, no network, no cmd needed
npm run typecheck
npm run build     # bb plugin build
bb plugin install .
```

## Known gaps

- No per-tool permission prompts (upstream limitation, above).
- Context usage only: the adapter sends ACP `usage_update` after every model request, so BB's context meter fills in, but BB's ACP bridge has no token or cost totals to report into.
- `fork: "none"` — Command Code cannot clone a session, so BB's thread fork and edit-past-message are unavailable.
- Images reach vision-capable models indirectly: BB passes a local image as its on-disk path and the model opens it with `read_file`, one extra tool call. Image URLs and audio are not forwarded.

## License

MIT
