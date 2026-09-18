import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import {
  CLOBBER_LIVE_HELPER_DETAIL,
  SANDBOXED_LAUNCH_AGENT_DETAIL,
  insideTemporaryDirectory,
  plistUsesTemporaryIO,
  refusesClobberingLiveHelper,
  refusesLiveLaunchd,
} from "../apps/bridge/src/launchd-safety";
import { installMonitorHelper, inspectMonitorHelper, reloadPairingHelper } from "../apps/bridge/src/install";

test("a plist under the operating system temp directory never reaches launchd", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "granttap-launchd-safety-"));
  const plist = join(sandbox, "Library", "LaunchAgents", "com.granttap.monitor.plist");
  assert.equal(insideTemporaryDirectory(plist), true);
  assert.match(refusesLiveLaunchd(plist) ?? "", new RegExp(SANDBOXED_LAUNCH_AGENT_DETAIL));

  // A real installation lives in the user's own Library, never under a temp root.
  const real = join(sep, "Users", "granttap", "Library", "LaunchAgents", "com.granttap.monitor.plist");
  assert.equal(insideTemporaryDirectory(real), false);
  assert.equal(refusesLiveLaunchd(real), null);
  assert.equal(insideTemporaryDirectory("/tmp/com.granttap.monitor.plist"), true);
});

test("installing the helper from a sandboxed home reports manual instead of hijacking the label", {
  skip: process.platform !== "darwin" ? "LaunchAgent installation is macOS-only" : false,
}, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "granttap-launchd-home-"));
  const previous = {
    agents: process.env.GRANTTAP_LAUNCH_AGENTS_DIR,
    skip: process.env.GRANTTAP_SKIP_LAUNCHCTL,
    config: process.env.GRANTTAP_CONFIG_DIR,
  };
  process.env.GRANTTAP_LAUNCH_AGENTS_DIR = join(home, "Library", "LaunchAgents");
  process.env.GRANTTAP_CONFIG_DIR = join(home, "config");
  // The suite normally sets the escape hatch; this asserts the guard that still
  // holds when a single test file, a probe, or an agent runs without it.
  delete process.env.GRANTTAP_SKIP_LAUNCHCTL;
  t.after(() => {
    for (const [key, value] of [
      ["GRANTTAP_LAUNCH_AGENTS_DIR", previous.agents],
      ["GRANTTAP_SKIP_LAUNCHCTL", previous.skip],
      ["GRANTTAP_CONFIG_DIR", previous.config],
    ] as const) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const result = installMonitorHelper();
  assert.equal(result.status, "manual");
  assert.match(result.detail, new RegExp(SANDBOXED_LAUNCH_AGENT_DETAIL));
});

test("a temporary config must not rewrite a live LaunchAgent", () => {
  const live = join(sep, "Users", "granttap", "Library", "LaunchAgents");
  const temp = join(sep, "var", "folders", "xx", "granttap-http-devices-Lbcnxp");
  assert.equal(refusesClobberingLiveHelper({
    agentsDir: join(temp, "LaunchAgents"),
    logPath: join(temp, "monitor.log"),
    workingDirectory: temp,
    configDirectory: temp,
  }), null);
  assert.equal(refusesClobberingLiveHelper({
    agentsDir: live,
    logPath: join(temp, "monitor.log"),
    workingDirectory: join(sep, "Users", "granttap", "dev", "granttap-mcp"),
    configDirectory: temp,
  }), CLOBBER_LIVE_HELPER_DETAIL);
  assert.match(plistUsesTemporaryIO([
    "<key>WorkingDirectory</key>",
    "<string>/Users/granttap/dev/granttap-mcp</string>",
    "<key>StandardErrorPath</key>",
    `<string>${temp}/monitor.log</string>`,
  ].join("\n")) ? "temp" : "", /temp/);
});

test("pairing and inspect refuse a live helper backed by a temporary log", async (t) => {
  const previous = {
    agents: process.env.GRANTTAP_LAUNCH_AGENTS_DIR,
    config: process.env.GRANTTAP_CONFIG_DIR,
    cwd: process.env.GRANTTAP_MONITOR_CWD,
  };
  const liveAgents = join(process.cwd(), `.granttap-ci-agents-${process.pid}`);
  const liveConfig = join(process.cwd(), `.granttap-ci-config-${process.pid}`);
  const tempConfig = await mkdtemp(join(tmpdir(), "granttap-ci-temp-config-"));
  mkdirSync(liveAgents, { recursive: true });
  writeFileSync(join(liveAgents, "com.granttap.monitor.plist"), [
    "<dict>",
    "<key>Label</key><string>com.granttap.monitor</string>",
    "<key>ProgramArguments</key><array>",
    "<string>internal</string><string>monitor</string>",
    "</array>",
    "<key>WorkingDirectory</key><string>/Users/granttap/dev/granttap-mcp</string>",
    "<key>StandardErrorPath</key><string>/var/folders/xx/granttap-http-devices-Lbcnxp/monitor.log</string>",
    "</dict>",
  ].join(""));
  process.env.GRANTTAP_LAUNCH_AGENTS_DIR = liveAgents;
  process.env.GRANTTAP_CONFIG_DIR = tempConfig;
  process.env.GRANTTAP_MONITOR_CWD = process.cwd();
  t.after(() => {
    rmSync(liveAgents, { recursive: true, force: true });
    rmSync(liveConfig, { recursive: true, force: true });
    rmSync(tempConfig, { recursive: true, force: true });
    for (const [key, value] of [
      ["GRANTTAP_LAUNCH_AGENTS_DIR", previous.agents],
      ["GRANTTAP_CONFIG_DIR", previous.config],
      ["GRANTTAP_MONITOR_CWD", previous.cwd],
    ] as const) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });

  assert.equal(inspectMonitorHelper().configured, false);
  assert.equal(reloadPairingHelper({ firstPairing: true }), undefined);
  const clobber = installMonitorHelper();
  assert.equal(clobber.status, "manual");
  assert.match(clobber.detail, /temporary config|live LaunchAgent/);

  process.env.GRANTTAP_CONFIG_DIR = liveConfig;
  mkdirSync(liveConfig, { recursive: true });
  const blocked = installMonitorHelper();
  assert.equal(blocked.status, "manual");
  assert.match(blocked.detail, /live LaunchAgent/);
});
