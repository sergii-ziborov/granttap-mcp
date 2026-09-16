import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CURSOR_HTTP_MCP_URL,
  inspectCursorHttpConfig,
  installCursorHttpConfig,
  removeCursorUserGrantTap,
} from "../apps/mcp/src/cursor-config";

test("removing the user GrantTap MCP entry keeps unrelated servers", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-cursor-config-"));
  const path = join(root, ".cursor", "mcp.json");
  await mkdir(join(root, ".cursor"), { recursive: true });
  await writeFile(path, JSON.stringify({
    mcpServers: {
      github: { command: "github-mcp" },
      granttap: { url: CURSOR_HTTP_MCP_URL },
    },
    project: "keep-me",
  }));

  assert.equal(inspectCursorHttpConfig(path).status, "action_required");
  assert.match(inspectCursorHttpConfig(path).detail, /127\.0\.0\.1/);
  assert.equal(removeCursorUserGrantTap(path).status, "installed");
  const kept = JSON.parse(await readFile(path, "utf8")) as {
    project: string;
    mcpServers: Record<string, Record<string, unknown>>;
  };
  assert.equal(kept.project, "keep-me");
  assert.deepEqual(kept.mcpServers.github, { command: "github-mcp" });
  assert.equal(kept.mcpServers.granttap, undefined);
  assert.equal(inspectCursorHttpConfig(path).status, "not_configured");
  assert.equal(removeCursorUserGrantTap(path).status, "already");
  assert.ok((await readFile(`${path}.bak-granttap-user`, "utf8")).includes(CURSOR_HTTP_MCP_URL));
});

test("installing a leftover HTTP entry is still detected as action required", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-cursor-install-"));
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
  assert.match(inspectCursorHttpConfig(path).detail, /127\.0\.0\.1/);
  assert.equal(installCursorHttpConfig(path).status, "already");
});

test("Cursor OAuth config install fails closed on invalid JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-cursor-invalid-"));
  const path = join(root, "mcp.json");
  await writeFile(path, "{");
  assert.equal(inspectCursorHttpConfig(path).status, "action_required");
  assert.equal(installCursorHttpConfig(path).status, "manual");
  assert.equal(removeCursorUserGrantTap(path).status, "manual");
  assert.equal(await readFile(path, "utf8"), "{");
});
