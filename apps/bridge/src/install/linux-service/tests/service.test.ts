import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installLinuxService, linuxServiceDefinition } from "../index";

test("a Linux service preserves literal paths and installs only the current user's named GrantTap unit", t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-systemd-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "bin")); writeFileSync(join(root, "package.json"), '{"version":"0.8.77"}');
  const node = join(root, "node $literal %host"); const launcher = join(root, "bin", "granttap-mcp.mjs");
  writeFileSync(node, "node"); chmodSync(node, 0o700); writeFileSync(launcher, "launcher");
  const calls: string[][] = [];
  const command = (args: string[]) => { calls.push(args); return { status: args[0] === "is-active" ? 1 : 0 }; };
  const options = { directory: root, command, uid: 1000, configDirectory: root };
  const result = installLinuxService("monitor", node, launcher, options);
  assert.equal(result.status, "installed");
  const contents = readFileSync(join(root, "granttap-monitor.service"), "utf8");
  assert(contents.includes(`ExecStart=:"${node.replaceAll("%", "%%")}" "${launcher}" internal monitor`));
  assert(contents.includes("UMask=0077")); assert(contents.includes("WantedBy=default.target"));
  assert.deepEqual(calls, [["daemon-reload"], ["enable", "granttap-monitor.service"], ["restart", "granttap-monitor.service"]]);
  calls.length = 0;
  const repeated = installLinuxService("monitor", node, launcher, { ...options, command: () => ({ status: 0 }) });
  assert.equal(repeated.status, "already");
  assert.throws(() => linuxServiceDefinition("monitor", node + "\nExecStart=other", launcher, root));
});

test("failed service registration restores the previous owned unit and refuses unrelated units or root installation", t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-systemd-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "bin")); writeFileSync(join(root, "package.json"), '{"version":"0.8.77"}');
  const node = join(root, "node"); const launcher = join(root, "bin", "granttap-mcp.mjs");
  writeFileSync(node, "node"); chmodSync(node, 0o700); writeFileSync(launcher, "launcher");
  const options = { directory: root, command: () => ({ status: 1 }), uid: 1000, configDirectory: root };
  const path = join(root, "granttap-http.service");
  assert.equal(installLinuxService("http", node, launcher, options).status, "manual");
  assert.equal(existsSync(path), false);
  const previous = linuxServiceDefinition("http", node, launcher, root);
  writeFileSync(path, previous);
  assert.equal(installLinuxService("http", node, launcher, { ...options, forceReload: true }).status, "manual");
  assert.equal(readFileSync(path, "utf8"), previous);
  writeFileSync(path, "[Service]\nExecStart=/usr/bin/unrelated\n");
  let commands = 0;
  assert.equal(installLinuxService("http", node, launcher, { ...options, command: () => { commands++; return { status: 0 }; } }).status, "manual");
  assert.equal(commands, 0); assert(readFileSync(path, "utf8").includes("unrelated"));
  assert.equal(installLinuxService("monitor", node, launcher, { ...options, uid: 0 }).status, "manual");
});
