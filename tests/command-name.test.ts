import assert from "node:assert/strict";
import test from "node:test";
import { commandName, toObservedCapability, toRemoteCapabilityUsageEvent } from "../apps/bridge/src/sessions/telemetry";

test("a shell call is named by the command it ran, not by the tool that ran it", () => {
  assert.equal(commandName("npm test"), "npm");
  assert.equal(commandName("cd apps/ios && xcodebuild test -scheme GrantTap"), "xcodebuild");
  assert.equal(commandName("FOO=1 sudo ./scripts/release/check.sh --ci"), "check.sh");
  assert.equal(commandName("cd ~/dev; git status | head -3"), "git");
  assert.equal(commandName("/opt/homebrew/bin/rg -n pattern src"), "rg");
  assert.equal(commandName("--flag-only"), undefined, "a flag is not a command");
  assert.equal(commandName(""), undefined);
  assert.equal(commandName(undefined), undefined);
  assert.equal(commandName("cd"), undefined);
});

test("observed and remote CLI capabilities carry the command's name and keep the tool", () => {
  const observation = {
    sourceId: "s:1", sessionId: "chat", toolName: "Bash", createdAt: 1, cli: true as const,
    commandPreview: { command: "cd apps && npm run build" }, outcome: "success" as const,
  };
  const observed = toObservedCapability(observation);
  assert.equal(observed.kind, "cli");
  assert.equal(observed.name, "npm");
  assert.equal(observed.toolName, "Bash");
  assert.equal(observed.commandPreview, "cd apps && npm run build");
  const remote = toRemoteCapabilityUsageEvent(observation)!;
  assert.equal(remote.name, "npm");
  assert.equal(remote.toolName, "Bash");
  // Without a preview, the tool's own name still names it.
  assert.equal(toObservedCapability({ ...observation, commandPreview: undefined }).name, "Bash");
  // MCP and skills are unaffected.
  assert.equal(toObservedCapability({ ...observation, cli: undefined, mcpServer: "github" } as any).name, "github");
});
