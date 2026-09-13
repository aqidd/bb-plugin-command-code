#!/usr/bin/env node
/**
 * ACP agent for Command Code.
 *
 * Speaks the Agent Client Protocol on stdio and drives `cmd -p
 * --output-format json` underneath, so any ACP client (BB, Zed, JetBrains,
 * Neovim) can run Command Code.
 */

import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";

import { buildCmdArgs, flattenPrompt, runCmdTurn } from "../src/cmd-session.mjs";
import { applyConfigOption, buildConfigOptions, loadCmdCatalog } from "../src/list-models.mjs";
import { loadSessionStore } from "../src/session-store.mjs";

const VERSION = "0.1.0";

function parseArgv(argv) {
  const options = {
    executable: process.env.COMMAND_CODE_EXECUTABLE ?? "cmd",
    allowWrites: false,
    model: undefined,
    effort: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--yolo" || arg === "--dangerously-skip-permissions") options.allowWrites = true;
    else if (arg === "--readonly") options.allowWrites = false;
    else if (arg === "--model") options.model = argv[++i];
    else if (arg === "--effort") options.effort = argv[++i];
    else if (arg === "--cmd") options.executable = argv[++i];
  }
  return options;
}

class CommandCodeAgent {
  #connection;
  #options;
  #store;
  #catalog;
  /** @type {Map<string, AbortController>} */
  #running = new Map();

  constructor(connection, options, store) {
    this.#connection = connection;
    this.#options = options;
    this.#store = store;
  }

  initialize(params) {
    return {
      protocolVersion: params?.protocolVersion ?? 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { embeddedContext: true, image: false, audio: false },
      },
      authMethods: [],
      agentInfo: { name: "command-code-acp", version: VERSION },
    };
  }

  // cmd owns its own auth (`cmd login`), so there is nothing to negotiate here.
  authenticate() {
    return {};
  }

  /** A failed model listing leaves the session on cmd's defaults rather than failing it. */
  #loadCatalog() {
    this.#catalog ??= loadCmdCatalog(this.#options.executable).catch((error) => {
      process.stderr.write(`command-code-acp: model catalog unavailable: ${error.message}\n`);
      return { models: [], efforts: new Map(), contexts: new Map() };
    });
    return this.#catalog;
  }

  async #configOptions(record) {
    const { models, efforts } = await this.#loadCatalog();
    return buildConfigOptions(models, efforts, record);
  }

  async newSession(params) {
    const sessionId = randomUUID();
    const record = {
      cwd: params?.cwd,
      cmdSessionId: undefined,
      model: this.#options.model,
      effort: this.#options.effort,
    };
    await this.#store.put(sessionId, record);
    return { sessionId, configOptions: await this.#configOptions(record) };
  }

  async loadSession(params) {
    let record = await this.#store.get(params.sessionId);
    if (record === undefined) {
      record = { cwd: params?.cwd, cmdSessionId: undefined };
      await this.#store.put(params.sessionId, record);
    }
    return { configOptions: await this.#configOptions(record) };
  }

  async setSessionConfigOption(params) {
    const record = (await this.#store.get(params.sessionId)) ?? {};
    const { efforts } = await this.#loadCatalog();
    const next = applyConfigOption(record, params.configId, String(params.value), efforts);
    await this.#store.put(params.sessionId, next);
    return { configOptions: await this.#configOptions(next) };
  }

  async prompt(params) {
    const { sessionId } = params;
    const record = (await this.#store.get(sessionId)) ?? {};
    // The config options clamp a stale or unsupported effort before cmd can reject it.
    const configOptions = await this.#configOptions(record);
    const selected = (category) => configOptions.find((o) => o.category === category)?.currentValue;
    const { contexts } = await this.#loadCatalog();
    const controller = new AbortController();
    this.#running.set(sessionId, controller);

    try {
      const { stopReason, cmdSessionId } = await runCmdTurn({
        executable: this.#options.executable,
        args: buildCmdArgs({
          cmdSessionId: record.cmdSessionId,
          allowWrites: this.#options.allowWrites,
          model: selected("model") ?? record.model,
          effort: selected("thought_level"),
        }),
        cwd: params.cwd ?? record.cwd ?? process.cwd(),
        env: process.env,
        prompt: flattenPrompt(params.prompt),
        signal: controller.signal,
        onUpdate: (update) => {
          void this.#connection.sessionUpdate({ sessionId, update });
        },
        onLog: (text) => process.stderr.write(text),
        contexts,
      });

      if (cmdSessionId !== undefined && cmdSessionId !== record.cmdSessionId) {
        await this.#store.put(sessionId, { ...record, cmdSessionId });
      }
      return { stopReason };
    } finally {
      this.#running.delete(sessionId);
    }
  }

  cancel(params) {
    this.#running.get(params?.sessionId)?.abort();
  }
}

const options = parseArgv(process.argv.slice(2));
const store = await loadSessionStore();
const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));

new AgentSideConnection((connection) => new CommandCodeAgent(connection, options, store), stream);
