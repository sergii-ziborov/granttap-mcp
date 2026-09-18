/** Persistent, terminal-free task sync for the GrantTap phone app on macOS. */
import { join } from "node:path";
import { RelayClient } from "../../../../packages/core/relay-client";
import { configDir, loadConfig, machineConfigPath } from "../config";
import { EngineSupervisor } from "../engine/engine-supervisor";
import { startSessionMonitor } from "../monitor";

let client: RelayClient;
let monitor: ReturnType<typeof startSessionMonitor>;
const engine = new EngineSupervisor();
let stopping = false;

try {
  const cfg = loadConfig(machineConfigPath());
  client = new RelayClient(cfg, {
    autoReconnect: true,
    replayPath: join(configDir(), `replay-${cfg.room}.json`),
  });
  monitor = startSessionMonitor(client);
} catch (error) {
  process.stderr.write(
    `[granttap-mcp] monitor is not paired: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}

const stop = (): void => {
  if (stopping) return;
  stopping = true;
  monitor.close();
  client.close();
  void engine.stop().finally(() => process.exit(0));
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

void engine.ensureAvailable().then((health) => {
  if (health.state !== "disabled" && health.state !== "healthy") {
    const reason = health.reason ? `: ${health.reason}` : "";
    process.stderr.write(
      `[granttap-mcp] Project engine ${health.state}${reason}; legacy behavior remains active\n`,
    );
  }
});

void client
  .connect()
  .then(() => monitor.publish())
  .catch((error: unknown) => {
    // RelayClient keeps reconnecting in the background. Log the initial error
    // for diagnostics without terminating the launchd-managed helper.
    process.stderr.write(
      `[granttap-mcp] initial relay connection failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  });
