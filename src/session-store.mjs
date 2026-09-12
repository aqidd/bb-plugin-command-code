/**
 * Maps ACP session ids to Command Code session ids.
 *
 * cmd mints its own session id on the first run and only accepts it back via
 * `--resume`, so the pairing has to outlive the adapter process for ACP
 * `session/load` to restore a conversation.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STORE_PATH =
  process.env.COMMAND_CODE_ACP_STORE ?? join(homedir(), ".command-code-acp", "sessions.json");

/** ponytail: whole-file rewrite; sessions are tens of rows, not a database. */
export async function loadSessionStore(path = STORE_PATH) {
  let records = {};
  try {
    records = JSON.parse(await readFile(path, "utf8"));
    if (records === null || typeof records !== "object") records = {};
  } catch {
    records = {};
  }

  let writing = Promise.resolve();

  const persist = () => {
    writing = writing.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(records, null, 2), "utf8");
      await rename(temp, path);
    });
    return writing;
  };

  return {
    async get(sessionId) {
      return records[sessionId];
    },
    async put(sessionId, record) {
      records[sessionId] = record;
      await persist();
    },
  };
}
