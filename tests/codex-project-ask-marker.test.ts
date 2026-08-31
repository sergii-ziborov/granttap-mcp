import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  consumeCodexProjectAsk,
  recordCodexProjectAsk,
} from "../apps/bridge/src/policy/codex-project-ask";

test("Codex Project ASK marker is exact, single-use, bounded, and secret-blind", async (t) => {
  const root = await isolatedConfig(t);
  const call = {
    sessionId: "session",
    toolUseId: "call-1",
    toolName: "shell_command",
    toolInput: { command: ["echo", "private-token"], cwd: " /repo " },
  };
  assert.equal(recordCodexProjectAsk(call, "Project asks", 1_000), true);
  assert.equal(recordCodexProjectAsk(call, "duplicate", 1_001), false);

  const directory = join(root, "codex-project-asks");
  const names = await readdir(directory);
  assert.equal(names.length, 1);
  const persisted = await readFile(join(directory, names[0]!), "utf8");
  assert.doesNotMatch(persisted, /private-token|shell_command|session|call-1/);

  assert.equal(consumeCodexProjectAsk({ ...call, toolUseId: "call-2" }, 1_002), undefined);
  assert.equal(consumeCodexProjectAsk({
    ...call,
    toolInput: { cwd: "/repo", command: ["echo", "private-token"] },
  }, 1_002)?.reason, "Project asks");
  assert.equal(consumeCodexProjectAsk(call, 1_003), undefined, "marker cannot be replayed");
});

test("Codex Project ASK marker expires and requires provider call identity", async (t) => {
  await isolatedConfig(t);
  const call = {
    sessionId: "session",
    toolUseId: "call-stale",
    toolName: "shell_command",
    toolInput: { command: "npm test" },
  };
  assert.equal(recordCodexProjectAsk(call, "Project asks", 5_000), true);
  assert.equal(consumeCodexProjectAsk(call, 35_001), undefined);
  assert.equal(recordCodexProjectAsk({ ...call, toolUseId: undefined }, "Project asks"), false);
  assert.equal(recordCodexProjectAsk({ ...call, sessionId: undefined }, "Project asks"), false);
});

async function isolatedConfig(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "granttap-codex-project-ask-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(async () => {
    if (previous == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
