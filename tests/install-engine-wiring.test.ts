import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installMonitorHelper } from "../apps/bridge/src/install";
import { saveRuntimeConfig } from "../apps/bridge/src/config";

async function sandbox(t: { after: (fn: () => void) => void }): Promise<{
  agentsDir: string; root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "granttap-engine-wiring-"));
  const agentsDir = join(root, "LaunchAgents");
  const kept = new Map<string, string | undefined>();
  const set = (key: string, value: string) => {
    kept.set(key, process.env[key]);
    process.env[key] = value;
  };
  set("GRANTTAP_LAUNCH_AGENTS_DIR", agentsDir);
  set("GRANTTAP_CONFIG_DIR", join(root, "config"));
  set("GRANTTAP_MONITOR_CWD", join(root, "workspace"));
  set("GRANTTAP_PINNED_MONITOR_BIN", join(root, "missing-nodvox-monitor"));
  set("GRANTTAP_PINNED_MONITOR_ROOT", join(root, "missing-nodvox-root"));
  set("GRANTTAP_SKIP_LAUNCHCTL", "1");
  t.after(() => {
    for (const [key, value] of kept) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return { agentsDir, root };
}

const CHECKSUM = "a".repeat(64);

test("a configured engine is wired into the LaunchAgent that publishes", async (t) => {
  if (process.platform !== "darwin") return t.skip("LaunchAgent is macOS-only");
  const { agentsDir, root } = await sandbox(t);
  const binary = join(root, "granttap-engine");
  await writeFile(binary, "#!/bin/sh\n", { mode: 0o755 });
  // The engine ships separately, so its location is declared rather than assumed.
  saveRuntimeConfig({ enginePath: binary, engineSha256: CHECKSUM });

  assert.equal(installMonitorHelper().status, "installed");
  const plist = await readFile(join(agentsDir, "com.granttap.monitor.plist"), "utf8");
  assert.match(plist, /<key>GRANTTAP_ENGINE_BINARY<\/key>/);
  assert.match(plist, new RegExp(`<string>${binary}</string>`));
  assert.match(plist, new RegExp(`<key>GRANTTAP_ENGINE_SHA256</key>\\s*<string>${CHECKSUM}</string>`));
  // Governance is what the phone is waiting for, and it needs both rollout flags.
  assert.match(plist, /<key>GRANTTAP_ENGINE_ENABLED<\/key>\s*<string>1<\/string>/);
  assert.match(plist, /<key>GRANTTAP_PROJECT_POLICY_ENABLED<\/key>\s*<string>1<\/string>/);
});

test("no engine configured leaves the rollout flags off", async (t) => {
  if (process.platform !== "darwin") return t.skip("LaunchAgent is macOS-only");
  const { agentsDir } = await sandbox(t);
  saveRuntimeConfig({ meshEnabled: true });

  assert.equal(installMonitorHelper().status, "installed");
  const plist = await readFile(join(agentsDir, "com.granttap.monitor.plist"), "utf8");
  assert.doesNotMatch(plist, /GRANTTAP_ENGINE_ENABLED/);
  assert.doesNotMatch(plist, /GRANTTAP_PROJECT_POLICY_ENABLED/);
  assert.doesNotMatch(plist, /GRANTTAP_ENGINE_BINARY/);
});

test("a malformed engine declaration is refused rather than half-applied", async (t) => {
  if (process.platform !== "darwin") return t.skip("LaunchAgent is macOS-only");
  const { agentsDir, root } = await sandbox(t);
  // A relative path and a short checksum are both unusable to verifyEngineBinary.
  saveRuntimeConfig({ enginePath: "engine", engineSha256: "abc" });
  assert.equal(installMonitorHelper().status, "installed");
  let plist = await readFile(join(agentsDir, "com.granttap.monitor.plist"), "utf8");
  assert.doesNotMatch(plist, /GRANTTAP_ENGINE_ENABLED/);

  // A checksum without a path is equally unusable.
  saveRuntimeConfig({ enginePath: join(root, "engine"), engineSha256: null });
  installMonitorHelper();
  plist = await readFile(join(agentsDir, "com.granttap.monitor.plist"), "utf8");
  assert.doesNotMatch(plist, /GRANTTAP_ENGINE_ENABLED/);
});
