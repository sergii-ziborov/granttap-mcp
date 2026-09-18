import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Payload } from "../packages/protocol/schema";
import { saveRuntimeConfig } from "../apps/bridge/src/config";
import { currentInstanceEpoch } from "../apps/bridge/src/instance-epoch";
import { applyHostGrant, rememberExecutionPolicy } from "../apps/bridge/src/mesh/execution-policy";
import { computerId } from "../apps/bridge/src/mesh/computer-identity";
import { writePrivateFile } from "../apps/bridge/src/config/write-private";
import { delegationLoopPath } from "../apps/bridge/src/mesh/delegation-loop";

class FakeRelay {
  readonly room = "monitor-task-create-room";
  isConnected = true;
  sent: Payload[] = [];
  async send(payload: Payload) { this.sent.push(payload); }
}

async function grokFixture(root: string): Promise<{ repo: string; sessions: string }> {
  const repo = join(root, "repo");
  const sessions = join(root, "sessions");
  const session = join(sessions, "project", "grok-existing");
  await mkdir(session, { recursive: true });
  await writeFile(join(session, "summary.json"), JSON.stringify({
    info: { id: "grok-existing", cwd: repo }, generated_title: "Pin",
    created_at: Date.now() - 2_000, updated_at: Date.now(), current_model_id: "grok-build",
  }));
  await writeFile(join(session, "chat_history.jsonl"), `${JSON.stringify({
    role: "user", timestamp: Date.now(), content: "Verify",
  })}\n`);
  const bin = join(root, "grok-fixture");
  await writeFile(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
const selectedAt = args.indexOf("--session-id");
const sessionId = args[selectedAt + 1] ?? "grok-new";
process.stdout.write(JSON.stringify({ type: "text", data: "Grok created" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "end", sessionId }) + "\\n");
`, { mode: 0o755 });
  process.env.GRANTTAP_GROK_SESSIONS_DIR = sessions;
  process.env.GRANTTAP_GROK_BIN = bin;
  return { repo, sessions };
}

test("task.create refuses stale epoch, loops, missing files, and a disabled host", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-task-create-"));
  const fixture = await grokFixture(root);
  process.env.GRANTTAP_CONFIG_DIR = join(root, "config");
  t.after(() => {
    delete process.env.GRANTTAP_CONFIG_DIR;
    delete process.env.GRANTTAP_GROK_SESSIONS_DIR;
    delete process.env.GRANTTAP_GROK_BIN;
  });
  const { handleTaskCreate, handleHostGrant } = await import("../apps/bridge/src/monitor");
  const fake = new FakeRelay();
  const base = {
    type: "project.task.create" as const,
    text: "Ship the pin",
    cwd: fixture.repo,
    agent: "grok" as const,
    createdAt: Date.now(),
  };

  await handleTaskCreate(fake as never, {
    ...base, operationId: "stale-epoch-op", instanceEpoch: "deadbeefdeadbeef",
  });
  assert.match(JSON.stringify(fake.sent.at(-1)), /previous instance/);

  writePrivateFile(delegationLoopPath(), `${JSON.stringify({
    hops: [{ operationId: "parent-loop-op", hops: 2 }],
  })}\n`);
  await handleTaskCreate(fake as never, {
    ...base, operationId: "child-loop-op", parentSessionId: "parent-loop-op",
    instanceEpoch: currentInstanceEpoch(),
  });
  assert.match(JSON.stringify(fake.sent.at(-1)), /cannot create another task/);

  saveRuntimeConfig({
    providerSettings: { claude: true, codex: true, cursor: true, grok: false },
  });
  await handleTaskCreate(fake as never, {
    ...base, operationId: "disabled-grok-op", instanceEpoch: currentInstanceEpoch(),
  });
  assert.match(JSON.stringify(fake.sent.at(-1)), /disabled in GrantTap Settings/);

  saveRuntimeConfig({
    providerSettings: { claude: true, codex: true, cursor: true, grok: true },
  });
  await handleTaskCreate(fake as never, {
    ...base, operationId: "missing-file-op", instanceEpoch: currentInstanceEpoch(),
    attachmentRefs: [{ attachmentId: "missing-shot", name: "shot.png", mimeType: "image/png" }],
  });
  assert.match(JSON.stringify(fake.sent.at(-1)), /attachment-missing/);

  await handleTaskCreate(fake as never, {
    ...base, operationId: "unknown-cwd-op", cwd: join(root, "missing"),
    instanceEpoch: currentInstanceEpoch(),
  });
  assert.match(JSON.stringify(fake.sent.at(-1)), /not one of the agent workspaces/);

  const endpoint = computerId();
  rememberExecutionPolicy("proj-pin", {
    mode: "pinned",
    targetEndpointId: endpoint,
    revision: 1,
    hostGrantStatus: "pending",
    offlineBehavior: "queueUntilDeadline",
  }, endpoint);
  handleHostGrant({
    type: "project.execution.host-grant",
    projectId: "proj-pin",
    grant: "unavailable",
    revision: 1,
    instanceEpoch: "wrong-epoch-xxxxxxxx",
    createdAt: Date.now(),
  });
  assert.equal(applyHostGrant("proj-pin", "applied", 1, endpoint)?.hostGrantStatus, "applied");
  handleHostGrant({
    type: "project.execution.host-grant",
    projectId: "proj-pin",
    grant: "unavailable",
    revision: 1,
    instanceEpoch: currentInstanceEpoch(),
    createdAt: Date.now(),
  });
  assert.equal(applyHostGrant("proj-pin", "unavailable", 1, endpoint)?.hostGrantStatus, "unavailable");

  fake.isConnected = false;
  await handleTaskCreate(fake as never, {
    ...base, operationId: "create-success-op", instanceEpoch: currentInstanceEpoch(),
  });
  assert.match(JSON.stringify(fake.sent), /Grok created|not one of the agent workspaces|queued until the deadline|Creating a new/);
});
