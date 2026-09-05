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
    commandPreview: "cd apps && npm run build", outcome: "success" as const,
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

test("a preview cut short at a variable name does not name the call after the variable", () => {
  const command = "cd ~/dev/nodvox/apps/ios && LOG=/private/tmp/claude-501/-Users-serhiirihgt-dev-nodvox/2dc608d6-3e8f-43a7-9037-32793756e7f4/scratchpad/phone76.log; DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -project GrantTap.xcodeproj build";
  assert.equal(commandName(command), "xcodebuild");
  assert.equal(commandName(command.slice(0, 160)), undefined, "the cut preview ends in DEVELOPER_DIR, which is no command");
  const observed = toObservedCapability({
    sourceId: "s:1", sessionId: "chat", toolName: "Bash", createdAt: 1, cli: true as const,
    commandPreview: command, outcome: "success" as const,
  });
  assert.equal(observed.name, "xcodebuild", "named from the whole command, not the preview");
  assert.equal(observed.commandPreview?.length, 160);
});
