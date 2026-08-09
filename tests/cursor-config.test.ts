import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CURSOR_HTTP_MCP_URL,
  inspectCursorHttpConfig,
  installCursorHttpConfig,
} from "../apps/mcp/src/cursor-config";

test("Cursor OAuth config install preserves unrelated MCP servers and is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-cursor-config-"));
  const path = join(root, ".cursor", "mcp.json");
  await mkdir(join(root, ".cursor"), { recursive: true });
  await writeFile(path, JSON.stringify({
    mcpServers: {
      github: { command: "github-mcp" },
      granttap: { command: "npx", args: ["-y", "granttap-mcp@latest"] },
    },
    project: "keep-me",
  }));

  assert.equal(inspectCursorHttpConfig(path).status, "action_required");
  assert.equal(installCursorHttpConfig(path).status, "installed");
  const installed = JSON.parse(await readFile(path, "utf8")) as {
    project: string;
    mcpServers: Record<string, Record<string, unknown>>;
  };
  assert.equal(installed.project, "keep-me");
  assert.deepEqual(installed.mcpServers.github, { command: "github-mcp" });
  assert.deepEqual(installed.mcpServers.granttap, { url: CURSOR_HTTP_MCP_URL });
  assert.equal(inspectCursorHttpConfig(path).status, "action_required");
  assert.match(inspectCursorHttpConfig(path).detail, /Authorize/);
  assert.equal(installCursorHttpConfig(path).status, "already");
  assert.ok((await readFile(`${path}.bak-granttap`, "utf8")).includes("granttap-mcp@latest"));
});

test("Cursor OAuth config install fails closed on invalid JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-cursor-invalid-"));
  const path = join(root, "mcp.json");
  await writeFile(path, "{");
  assert.equal(inspectCursorHttpConfig(path).status, "action_required");
  assert.equal(installCursorHttpConfig(path).status, "manual");
  assert.equal(await readFile(path, "utf8"), "{");
});
