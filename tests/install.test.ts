import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installMonitorHelper } from "../apps/bridge/src/install";

test("macOS background task sync is installed as a terminal-free LaunchAgent", async (t) => {
  if (process.platform !== "darwin") return t.skip("LaunchAgent is macOS-only");
  const root = await mkdtemp(join(tmpdir(), "granttap-launch-agent-"));
  const agentsDir = join(root, "LaunchAgents");
  const configDir = join(root, "config");
  const previous = {
    agents: process.env.GRANTTAP_LAUNCH_AGENTS_DIR,
    config: process.env.GRANTTAP_CONFIG_DIR,
    cwd: process.env.GRANTTAP_MONITOR_CWD,
    skip: process.env.GRANTTAP_SKIP_LAUNCHCTL,
  };
  process.env.GRANTTAP_LAUNCH_AGENTS_DIR = agentsDir;
  process.env.GRANTTAP_CONFIG_DIR = configDir;
  process.env.GRANTTAP_MONITOR_CWD = "/tmp/granttap-default-workspace";
  process.env.GRANTTAP_SKIP_LAUNCHCTL = "1";
  t.after(() => {
    const restore = (key: string, value: string | undefined) => {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    };
    restore("GRANTTAP_LAUNCH_AGENTS_DIR", previous.agents);
    restore("GRANTTAP_CONFIG_DIR", previous.config);
    restore("GRANTTAP_MONITOR_CWD", previous.cwd);
    restore("GRANTTAP_SKIP_LAUNCHCTL", previous.skip);
  });

  const first = installMonitorHelper();
  assert.equal(first.status, "installed");
  const path = join(agentsDir, "com.granttap.monitor.plist");
  const plist = await readFile(path, "utf8");
  assert.match(plist, /<string>monitor<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<string>\/tmp\/granttap-default-workspace<\/string>/);
  assert.match(plist, /monitor\.log/);

  const second = installMonitorHelper();
  assert.equal(second.status, "already");
});
