import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectMonitorHelper } from "../../apps/bridge/src/install";

test("monitor discovery returns bounded unavailable state when launchd does not answer", (t) => {
  if (process.platform !== "darwin") return t.skip("LaunchAgent is macOS-only");
  const root = mkdtempSync(join(tmpdir(), "granttap-readiness-deadline-"));
  const bin = join(root, "bin");
  const agents = join(root, "agents");
  mkdirSync(bin); mkdirSync(agents);
  const launcher = join(bin, "launchctl");
  writeFileSync(launcher, "#!/usr/bin/env node\nsetTimeout(() => process.exit(0), 2000);\n");
  chmodSync(launcher, 0o755);
  writeFileSync(join(agents, "com.granttap.monitor.plist"), [
    "<plist><dict><key>Label</key><string>com.granttap.monitor</string>",
    "<key>ProgramArguments</key><array><string>/fixture/granttap-mcp.mjs</string>",
    "<string>internal</string><string>monitor</string></array></dict></plist>",
  ].join(""));
  const previousPath = process.env.PATH;
  const previousAgents = process.env.GRANTTAP_LAUNCH_AGENTS_DIR;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.GRANTTAP_LAUNCH_AGENTS_DIR = agents;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousAgents === undefined) delete process.env.GRANTTAP_LAUNCH_AGENTS_DIR;
    else process.env.GRANTTAP_LAUNCH_AGENTS_DIR = previousAgents;
    rmSync(root, { recursive: true, force: true });
  });
  const started = performance.now();
  const result = inspectMonitorHelper();
  assert.ok(performance.now() - started < 1500, "discovery must not stall the local status endpoint");
  assert.deepEqual(result, { configured: true, running: false });
  writeFileSync(launcher, "#!/usr/bin/env node\nprocess.exit(0);\n");
  assert.deepEqual(inspectMonitorHelper(), { configured: true, running: true });
});
