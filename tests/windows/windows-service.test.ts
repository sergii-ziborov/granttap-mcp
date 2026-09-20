import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectWindowsTask, installWindowsTask, restoreWindowsTask, snapshotWindowsTask, windowsTaskDefinition } from "../../apps/bridge/src/install/windows-service";

test("Cursor marketplace uses the orange GrantTap mark", () => {
  const root = join(import.meta.dirname, "../..");
  const logo = readFileSync(join(root, "cursor-plugin", "assets", "logo.svg"), "utf8");
  assert.match(logo, /fill="#f47f42"/);
  assert.match(logo, /M11 31\.5 24\.5 45 42 19/);
  assert.doesNotMatch(logo, /#3DDC97|#0B1F17/i);
});

test("Windows service restarts after logon and a crashed process without elevating", () => {
  const definition = windowsTaskDefinition("http", "C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\Alice\\AppData\\Roaming\\npm\\node_modules\\granttap-mcp\\bin\\granttap-mcp.mjs");
  assert.match(definition, /<Interval>PT1M<\/Interval>/);
  assert.match(definition, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(definition, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(definition, /<Command>C:\\Program Files\\nodejs\\node\.exe<\/Command>/);
  assert.match(definition, /<WorkingDirectory>C:\\Users\\Alice\\AppData\\Roaming\\npm\\node_modules\\granttap-mcp<\/WorkingDirectory>/);
  assert.match(definition, /internal serve/);
});

test("Windows installer preserves foreign tasks, registers a reusable user job, and rolls back only its own", {
  skip: process.platform === "win32",
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), "granttap-windows-tasks-"));
  const record = join(root, "task.xml");
  const node = join(root, "node.exe");
  const launcher = join(root, "bin", "granttap-mcp.mjs");
  linkSync(process.execPath, node);
  mkdirSync(join(root, "bin"));
  writeFileSync(launcher, "// fixture\n");
  writeFileSync(join(root, "package.json"), '{"version":"0.8.15"}');
  const stub = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const record = process.env.GRANTTAP_TEST_WINDOWS_RECORD;
if (args[0] === '/Query') {
  if (!fs.existsSync(record)) process.exit(1);
  process.stdout.write(fs.readFileSync(record));
} else if (args[0] === '/Create') {
  const path = args[args.indexOf('/XML') + 1];
  fs.writeFileSync(record, fs.readFileSync(path, 'utf16le').replace(/^\\uFEFF/, ''));
} else if (args[0] === '/Delete') {
  fs.unlinkSync(record);
} else if (args[0] === '/End') {
  fs.writeFileSync(record + '.end', 'ended');
} else if (args[0] === '/Run' && !fs.existsSync(record)) process.exit(1);
`;
  writeFileSync(join(root, "schtasks.exe"), stub, { mode: 0o755 });
  writeFileSync(join(root, "whoami.exe"), "#!/bin/sh\necho TestUser\n", { mode: 0o755 });
  writeFileSync(join(root, "powershell.exe"), "#!/bin/sh\necho Running\n", { mode: 0o755 });
  const oldPath = process.env.PATH;
  const oldConfig = process.env.GRANTTAP_CONFIG_DIR;
  const oldRecord = process.env.GRANTTAP_TEST_WINDOWS_RECORD;
  process.env.PATH = `${root}:${oldPath ?? ""}`;
  process.env.GRANTTAP_CONFIG_DIR = root;
  process.env.GRANTTAP_TEST_WINDOWS_RECORD = record;
  t.after(() => {
    if (oldPath == null) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldConfig == null) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = oldConfig;
    if (oldRecord == null) delete process.env.GRANTTAP_TEST_WINDOWS_RECORD; else process.env.GRANTTAP_TEST_WINDOWS_RECORD = oldRecord;
    rmSync(root, { recursive: true, force: true });
  });

  assert.equal(installWindowsTask("http", node, launcher).status, "installed");
  assert.deepEqual(inspectWindowsTask("http"), { configured: true, running: true });
  assert.equal(installWindowsTask("http", node, launcher).status, "already");
  assert.match(snapshotWindowsTask("http") ?? "", /InteractiveToken/);
  writeFileSync(join(root, "package.json"), '{"version":"0.8.16"}');
  assert.equal(installWindowsTask("http", node, launcher).status, "installed");
  assert.match(snapshotWindowsTask("http") ?? "", /GrantTap 0\.8\.16 http/);
  assert.equal(existsSync(`${record}.end`), true);
  assert.equal(restoreWindowsTask("http", null), true);
  assert.equal(existsSync(record), false);

  writeFileSync(record, "<Task><Command>foreign.exe</Command></Task>");
  assert.equal(installWindowsTask("http", node, launcher).status, "manual");
  assert.equal(restoreWindowsTask("http", null), false);
  assert.match(readFileSync(record, "utf8"), /foreign.exe/);
});
