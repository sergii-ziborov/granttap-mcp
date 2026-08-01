/** Persistent, terminal-free task sync for the GrantTap phone app on macOS. */
import { RelayClient } from "../../../../packages/core/relay-client";
import { loadConfig, machineConfigPath } from "../config";
import { startSessionMonitor } from "../monitor";

let client: RelayClient;
let monitor: ReturnType<typeof startSessionMonitor>;

try {
  client = new RelayClient(loadConfig(machineConfigPath()), { autoReconnect: true });
  monitor = startSessionMonitor(client);
} catch (error) {
  process.stderr.write(
    `[granttap-mcp] monitor is not paired: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}

const stop = (): void => {
  monitor.close();
  client.close();
  process.exit(0);
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

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
