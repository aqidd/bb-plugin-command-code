import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { localizeImageUrls } from "../src/cmd-session.mjs";

// 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
  "base64",
);

const ON_DISK = /^\[image attachment on disk: (.+)\]$/;

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test("a data: image URL is saved to disk and rewritten to BB's on-disk form", async () => {
  const dir = await mkdtemp(join(tmpdir(), "img-test-"));
  const text = `[image attachment: data:image/png;base64,${PNG.toString("base64")}]`;
  const match = ON_DISK.exec(await localizeImageUrls(text, { dir }));
  assert.ok(match, "rewritten to an on-disk attachment");
  assert.ok(match[1].startsWith(dir) && match[1].endsWith(".png"));
  assert.deepEqual(await readFile(match[1]), PNG);
});

test("an http image URL is downloaded so cmd's read_file can open it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "img-test-"));
  await withServer(
    (req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(PNG);
    },
    async (base) => {
      const out = await localizeImageUrls(`look at this\n\n[image attachment: ${base}/shot.png]`, { dir });
      const match = ON_DISK.exec(out.split("\n\n")[1]);
      assert.ok(match, "rewritten to an on-disk attachment");
      assert.deepEqual(await readFile(match[1]), PNG);
      assert.ok(out.startsWith("look at this"));
    },
  );
});

test("URLs that are missing or not images are left as they were", async () => {
  const dir = await mkdtemp(join(tmpdir(), "img-test-"));
  await withServer(
    (req, res) => {
      if (req.url === "/page") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html></html>");
      } else {
        res.writeHead(404);
        res.end();
      }
    },
    async (base) => {
      const text = `[image attachment: ${base}/missing.png] [image attachment: ${base}/page]`;
      assert.equal(await localizeImageUrls(text, { dir }), text);
    },
  );
});
