import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPairing } from "../apps/bridge/src/config";
import { forwardingRelay, waitFor } from "./support/forwarding-relay";

function launch(configDir: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawn(process.execPath, ["--import", "tsx", "apps/bridge/src/bin/monitor.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GRANTTAP_CONFIG_DIR: configDir,
      GRANTTAP_MONITOR_INTERVAL_MS: "60000",
      ...extraEnv,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
}

function closed(child: ReturnType<typeof launch>): Promise<{ code: number | null; stderr: string }> {
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stderr })));
}

test("monitor entry fails closed before pairing and stops cleanly on SIGTERM", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-monitor-bin-"));
  const unpaired = launch(join(root, "unpaired"));
  const missing = await closed(unpaired);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /not paired/);

  const relay = await forwardingRelay();
  t.after(() => relay.close());
  const config = join(root, "paired");
  await mkdir(config, { recursive: true });
  await writeFile(join(config, "machine.json"), JSON.stringify(createPairing(relay.url).machineCfg));
  const paired = launch(config, { GRANTTAP_ENGINE_ENABLED: "1" });
  const completion = closed(paired);
  await waitFor(() => relay.connections() === 1, 2_000);
  paired.kill("SIGTERM");
  const stopped = await completion;
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.match(stopped.stderr, /engine unavailable.*legacy behavior remains active/i);
});
