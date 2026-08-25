import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import {
  SANDBOXED_LAUNCH_AGENT_DETAIL,
  insideTemporaryDirectory,
  refusesLiveLaunchd,
} from "../apps/bridge/src/launchd-safety";
import { installMonitorHelper } from "../apps/bridge/src/install";

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
