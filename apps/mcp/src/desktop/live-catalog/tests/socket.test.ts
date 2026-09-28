import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startDesktopEngineBridge } from "../../engine-bridge";
import { encodeEngineFrame } from "../../../../../bridge/src/engine/protocol/engine-protocol";

test("the private desktop socket returns native turn state through the parsing worker", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "granttap-live-socket-"));
  const roots = {
    GRANTTAP_CONFIG_DIR: directory, GRANTTAP_COMPUTER_ID: "test-computer",
    GRANTTAP_CODEX_SESSIONS_DIR: join(directory, "codex"),
    GRANTTAP_CLAUDE_PROJECTS_DIR: join(directory, "claude"),
    GRANTTAP_CURSOR_TRANSCRIPTS_DIR: join(directory, "cursor"),
    GRANTTAP_GROK_SESSIONS_DIR: join(directory, "grok"),
  };
  const previous = Object.fromEntries(Object.keys(roots).map(key => [key, process.env[key]]));
  Object.assign(process.env, roots);
  t.after(() => {
    for (const key of Object.keys(roots)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  await mkdir(roots.GRANTTAP_CODEX_SESSIONS_DIR);
  const now = Date.now();
  await writeFile(join(roots.GRANTTAP_CODEX_SESSIONS_DIR, "rollout-test.jsonl"), [
    { timestamp: now - 1_000, type: "session_meta", payload: { id: "test-session", cwd: directory } },
    { timestamp: now, type: "event_msg", payload: { type: "task_started" } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  const storePath = join(directory, "project-mesh.json");
  await writeFile(storePath, JSON.stringify({ version: 1,
    projects: [{ projectId: "p", name: "Test", canonicalRepositoryId: "r", createdAt: 1 }],
    tasks: [{ taskId: "t", projectId: "p", title: "Test", goal: "Test", state: "working",
      ownerSessionId: "test-session", createdAt: 1, updatedAt: now }], bindings: [],
    executions: [{ taskId: "t", sessionId: "test-session", provider: "codex",
      computerId: "test-computer", workspace: directory, startedAt: 1, endedAt: now - 2_000 }],
  }));
  const bridge = await startDesktopEngineBridge({ storePath, client: {
    request: async () => { throw new Error("live catalog does not require Engine analysis"); },
    close() {},
  } });
  t.after(() => bridge.close());
  const result = await new Promise<any>((resolve, reject) => {
    const socket = createConnection(bridge.socketPath);
    let data = Buffer.alloc(0);
    socket.setTimeout(10_000, () => { socket.destroy(); reject(new Error("catalog timeout")); });
    socket.on("connect", () => socket.write(encodeEngineFrame({ protocol_version: 1,
      request_id: "live", operation: "desktop.live_catalog" })));
    socket.on("data", chunk => { data = Buffer.concat([data, chunk]); });
    socket.on("error", reject);
    socket.on("close", () => {
      try { resolve(JSON.parse(data.subarray(4).toString("utf8"))); } catch (error) { reject(error); }
    });
  });
  assert.equal(result.status, "ok");
  assert.equal(result.result.operation, "desktop.live_catalog");
  assert.equal(result.result.computer_id, "test-computer");
  assert.deepEqual(result.result.sessions.map((s: any) => [s.state, s.projectId, s.taskId]),
    [["working", "p", "t"]]);
});
