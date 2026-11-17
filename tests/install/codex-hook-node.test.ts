import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { versionRoot } from "../../apps/bridge/src/runtime-updates/selection.mjs";
import { codexHookSet, projectCodexHooks } from "../../apps/bridge/src/codex-hook-trust";
import { hookLaunchesRuntime, hookNodeAccepted, hookNodeCommand } from "../../apps/bridge/src/install/stable-node";
import { hookCommand, inspectAgentIntegrations, installCodexHook } from "../../apps/bridge/src/install";

function environment(t: test.TestContext, values: Record<string, string>): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/** Another Node install, as nvm lays one out: the reader of the hook runs on a different one. */
async function otherNode(root: string, version: string): Promise<string> {
  const bin = join(root, ".nvm", "versions", "node", version, "bin");
  await mkdir(bin, { recursive: true });
  await symlink(process.execPath, join(bin, "node"));
  return join(bin, "node");
}

test("a Codex hook set up under another Node counts as installed whichever Node reads it", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-codex-hook-node-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, "config"), codex = join(root, "codex");
  environment(t, { GRANTTAP_CONFIG_DIR: config, GRANTTAP_CODEX_DIR: codex });
  const cached = versionRoot(join(config, "runtime-updates"), "0.0.1");
  await mkdir(join(cached, "bin"), { recursive: true });
  await writeFile(join(cached, "bin", "granttap-mcp.mjs"), "");
  await writeFile(join(cached, "package.json"), JSON.stringify({ name: "granttap-mcp", version: "0.0.1" }));
  const setupNode = await otherNode(root, "v22.16.0");
  assert.notEqual(setupNode, process.execPath, "the reader runs on a different Node than the hook names");
  const launcher = (node: string) => `${hookNodeCommand("codex", node)} "${join(cached, "bin", "granttap-mcp.mjs")}" internal hook`;

  assert.equal(installCodexHook().status, "installed");
  const file = join(codex, "config.toml");
  const own = hookCommand("codex").replace(/ codex$/, "");
  await writeFile(file, (await readFile(file, "utf8")).replaceAll(own, launcher(setupNode)));
  const before = await readFile(file, "utf8");
  assert.deepEqual(codexHookSet(before), { permission: true, policy: true });
  assert.equal(inspectAgentIntegrations().find((item) => item.agent === "codex")?.hookConfigured, true);
  assert.equal(installCodexHook().status, "already", "Rewriting the command would void the trust Codex keeps for it.");
  assert.equal(await readFile(file, "utf8"), before);
  const [policy] = projectCodexHooks({ data: [{ hooks: [{ key: "k", eventName: "preToolUse",
    command: `${launcher(setupNode)} codex-policy`, handlerType: "command", source: "user", matcher: ".*",
    timeoutSec: 30, enabled: true, isManaged: false, currentHash: "a".repeat(64), trustStatus: "trusted" }], errors: [] }] });
  assert.equal(policy?.trustStatus, "trusted");
  assert.equal(policy?.command, `${launcher(setupNode)} codex-policy`, "the person's command is reported as written");

  // The Node the setup named was removed: the hook cannot run, so it is not installed.
  const gone = join(root, ".nvm", "versions", "node", "v20.0.0", "bin", "node");
  await writeFile(file, before.replaceAll(launcher(setupNode), launcher(gone)));
  assert.deepEqual(codexHookSet(await readFile(file, "utf8")), { permission: false, policy: false });
  assert.equal(inspectAgentIntegrations().find((item) => item.agent === "codex")?.hookConfigured, false);
});

test("only an existing executable named node by an absolute quoted path stands in for the reader's Node", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-hook-node-shape-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const node = await otherNode(root, "v22.13.1");
  const python = join(root, "python");
  await writeFile(python, "#!/bin/sh\n");
  await chmod(python, 0o755);
  const plain = join(root, "plain", "node");
  await mkdir(join(root, "plain"));
  await writeFile(plain, "");
  await chmod(plain, 0o644);
  await mkdir(join(root, "folder", "node"), { recursive: true });
  assert.equal(hookNodeAccepted("codex", hookNodeCommand("codex", node)), true);
  assert.equal(hookNodeAccepted("codex-policy", hookNodeCommand("codex", node)), true);
  assert.equal(hookNodeAccepted("codex", hookNodeCommand("codex")), true);
  assert.equal(hookNodeAccepted("codex", "node"), false, "a Codex hook outside the plugin PATH needs an absolute Node");
  assert.equal(hookNodeAccepted("codex", hookNodeCommand("codex", python)), false);
  assert.equal(hookNodeAccepted("codex", hookNodeCommand("codex", plain)), false, "not executable");
  assert.equal(hookNodeAccepted("codex", hookNodeCommand("codex", join(root, "folder", "node"))), false);
  assert.equal(hookNodeAccepted("codex", '"relative/bin/node"'), false);
  assert.equal(hookNodeAccepted("codex", '""'), false);
  assert.equal(hookNodeAccepted("claude", hookNodeCommand("codex", node)), false, "other providers keep plain node");
  assert.equal(hookNodeAccepted("claude", "node"), true);
  assert.equal(hookNodeAccepted("codex", '"C:\\Tools\\node.exe"', process.execPath, "win32"), false, "missing on disk");
  assert.equal(hookNodeAccepted("codex", '"node.exe"', process.execPath, "win32"), false);

  const runtime = join(root, "runtime");
  const command = (prefix: string, route = "codex") => `${prefix} "${join(runtime, "bin", "granttap-mcp.mjs")}" internal hook ${route}`;
  assert.equal(hookLaunchesRuntime(command(hookNodeCommand("codex", node)), "codex", runtime, "0.8.1", join(root, "cache")), true);
  assert.equal(hookLaunchesRuntime(command(hookNodeCommand("codex", node), "codex-policy"), "codex", runtime, "0.8.1", join(root, "cache")), false);
  assert.equal(hookLaunchesRuntime(`${command(hookNodeCommand("codex", node))}; echo extra`, "codex", runtime, "0.8.1", join(root, "cache")), false);
  assert.equal(hookLaunchesRuntime(command(hookNodeCommand("codex", node)), "codex", join(root, "elsewhere"), "0.8.1", join(root, "cache")), false);
});
