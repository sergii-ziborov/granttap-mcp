import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { protectedGrantTapAccess } from "../apps/bridge/src/self-protection";
import { HOOKS, runHook } from "./provider-hook-harness";

test("provider hooks deny direct access to GrantTap trust state before bypass or auto policy", (t) => {
  const configDir = mkdtempSync(join(tmpdir(), "granttap-self-protection-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const protectedPath = join(configDir, "machine.json");
  const cases: Array<[keyof typeof HOOKS, Record<string, unknown>]> = [
    ["claude", {
      session_id: "chat", tool_name: "Read", permission_mode: "bypassPermissions",
      tool_input: { file_path: protectedPath },
    }],
    ["codex", {
      session_id: "chat", tool_name: "shell_command",
      tool_input: { command: `cat ${protectedPath}` },
    }],
    ["codexPolicy", {
      session_id: "chat", tool_name: "Read", tool_input: { path: "~/.granttap/config.json" },
    }],
    ["cursor", { command: `cat ${protectedPath}` }],
    ["cursorMcp", {
      tool_name: "read_file", tool_input: { path: "$HOME/.granttap/session-keys.json" },
    }],
  ];
  for (const [provider, input] of cases) {
    const output = runHook(provider, configDir, input);
    assert.match(JSON.stringify(output), /protects its local pairing, key, and policy files/);
    assert.doesNotMatch(JSON.stringify(output), new RegExp(configDir.replaceAll("/", "\\/")));
  }
  assert.ok(protectedGrantTapAccess("Read", { path: "/tmp/.nodvox/key.json" }));
  assert.equal(protectedGrantTapAccess("Write", {
    file_path: "/repo/README.md", content: "Document ~/.granttap without reading it",
  }), null);
});

test("the guard covers trust state and unknown files while leaving diagnostics readable", () => {
  const denied = [
    "~/.granttap", "~/.granttap/", "~/.granttap/machine.json", "~/.granttap/session-keys.json",
    "~/.granttap/mesh-capabilities.json", "~/.granttap/grok-bot-endpoint.json",
    "~/.granttap/project-mesh.json", "~/.granttap/mesh-tool-calls.json",
    "~/.granttap/config.json", "~/.granttap/approval-records/pending.json",
    "~/.granttap/something-added-next-year.json", "~/.granttap/*", "~/.granttap/logs/../machine.json",
  ];
  for (const path of denied) {
    assert.ok(protectedGrantTapAccess("Read", { path }), `${path} must stay protected`);
  }
  const readable = [
    "~/.granttap/monitor.log", "~/.granttap/logs/http-mcp.log", "~/.granttap/monitor.lock",
    "~/.granttap/delivery-ledger.json",
  ];
  for (const path of readable) {
    assert.equal(protectedGrantTapAccess("Read", { path }), null, `${path} must stay readable`);
  }
  // A crash is diagnosable without a trusted terminal; the keys beside it are not.
  assert.equal(protectedGrantTapAccess("Bash", {}, "tail -60 ~/.granttap/monitor.log"), null);
  assert.equal(
    protectedGrantTapAccess("Bash", { command: "tail -60 ~/.granttap/monitor.log 2>&1 | head -5" }),
    null,
    "a whole command line, not just a bare path, must resolve to the entry it names",
  );
  assert.ok(protectedGrantTapAccess("Bash", {}, "cat ~/.granttap/machine.json"));
  assert.ok(protectedGrantTapAccess("Bash", {}, "cat ~/.granttap/mesh-tool-calls.json"));
  assert.ok(protectedGrantTapAccess(
    "Bash", {}, "echo forged > ~/.granttap/mesh-tool-calls.json",
  ));
  assert.ok(protectedGrantTapAccess("Write", { path: "~/.granttap/delivery-ledger.json" }));
  assert.ok(protectedGrantTapAccess("Write", { path: "~/.granttap/monitor.log" }));
  assert.ok(protectedGrantTapAccess(
    "Bash", { command: "rg --pre=cp error ~/.granttap/monitor.log" },
  ));
  assert.equal(protectedGrantTapAccess(
    "Write", { path: "~/.granttap/worktrees/task/src/index.ts" },
  ), null);
  assert.ok(
    protectedGrantTapAccess("Bash", { command: "cat ~/.granttap/monitor.log; cat ~/.granttap/machine.json" }),
    "a readable log must not carry a protected path past the guard",
  );
  assert.equal(protectedGrantTapAccess("Read", { path: "~/Library/Logs/GrantTap/monitor.err.log" }), null);
  // The product name inside an identifier is not a path into the config directory.
  assert.equal(
    protectedGrantTapAccess("Bash", { command: "launchctl print gui/501/com.granttap.monitor" }),
    null,
  );
  assert.equal(protectedGrantTapAccess("Bash", { command: "pgrep -fl com.granttap.mcp-http" }), null);
  assert.ok(protectedGrantTapAccess("Bash", { command: "cd $HOME && cat .granttap/session-keys.json" }));
});

test("a fault inside the guard is reported and allowed instead of blocking every tool", () => {
  const stderr: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(chunk.toString());
    return true;
  }) as typeof process.stderr.write;
  try {
    const hostile = { get path(): string { throw new Error("guard fault"); } };
    assert.equal(protectedGrantTapAccess("Read", hostile), null);
  } finally {
    process.stderr.write = write;
  }
  assert.match(stderr.join(""), /self-protection fault, allowing this call: guard fault/);
});
