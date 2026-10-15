import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadRuntimeConfig, setSessionMcpAllowed } from "../../../../../bridge/src/config";
import { startDesktopEngineBridge } from "../../engine-bridge";
import { invokeDesktop } from "../../native-access/invoke";

test("the authenticated native operation path discovers Task tools in a worker and controls locally", async t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-native-parity-"));
  const env = { GRANTTAP_CONFIG_DIR: root, GRANTTAP_COMPUTER_ID: "local" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const key of Object.keys(env)) {
      if (previous[key] == null) delete process.env[key]; else process.env[key] = previous[key];
    }
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, ".git"));
  const skill = join(root, ".agents", "skills", "review");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: fixture-review\ndescription: Synthetic review\n---\nReview.");
  writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: "never-executed" } } }));
  writeFileSync(join(root, "project-mesh.json"), JSON.stringify({ version: 1,
    projects: [{ projectId: "p", name: "Synthetic", createdAt: 1 }],
    tasks: [{ taskId: "t", projectId: "p", title: "Synthetic", goal: "Synthetic", state: "working", createdAt: 1, updatedAt: 2 }],
    executions: [{ taskId: "t", sessionId: "s", provider: "claude", computerId: "local", workspace: root, startedAt: 1 }],
  }));
  setSessionMcpAllowed("s", "fixture", false);
  const bridge = await startDesktopEngineBridge({ client: {
    request: async () => { throw new Error("These actions do not require Engine analysis"); }, close() {},
  } });
  t.after(() => bridge.close());
  const query = { project_id: "p", task_id: "t", session_id: "s" };
  const tools = await invokeDesktop(bridge.socketPath, "desktop.task_capabilities", query, 10_000) as {
    mcp_servers: Array<{ name: string; allowed: boolean }>; skills: Array<{ name: string }>;
  };
  assert.equal(tools.mcp_servers.find(server => server.name === "fixture")?.allowed, false);
  assert.equal(tools.skills.some(row => row.name === "fixture-review"), true);
  const pause = await invokeDesktop(bridge.socketPath, "desktop.task_control", { ...query, action: "pause" }, 5_000) as { result: { ok: boolean } };
  assert.equal(pause.result.ok, true);
  assert.deepEqual(loadRuntimeConfig().pausedSessions, ["s"]);
  const preferences = await invokeDesktop(bridge.socketPath, "desktop.task_preferences", { ...query, auto_accept_level: "ask" }, 5_000) as { accepted: boolean };
  assert.equal(preferences.accepted, true);
  await assert.rejects(invokeDesktop(bridge.socketPath, "desktop.task_preferences", { ...query, task_id: "other" }, 5_000));
});
