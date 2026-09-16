import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writePrivateFile } from "../apps/bridge/src/config/write-private";

test("writePrivateFile replaces an existing file so Windows connect can save twice", () => {
  const root = mkdtempSync(join(tmpdir(), "granttap-write-private-"));
  const path = join(root, "mcp-oauth.json");
  try {
    writePrivateFile(path, '{"clients":{}}\n');
    writePrivateFile(path, '{"clients":{"cursor":{"client_id":"1"}}}\n');
    assert.equal(readFileSync(path, "utf8"), '{"clients":{"cursor":{"client_id":"1"}}}\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
