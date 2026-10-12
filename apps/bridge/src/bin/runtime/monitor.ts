/** Persistent, terminal-free task sync for the GrantTap phone app on macOS. */
import { join } from "node:path";
import { RelayClient } from "../../../../../packages/core/relay-client";
import { configDir, loadConfig, machineConfigPath } from "../../config";
import { EngineSupervisor } from "../../engine/runtime/engine-supervisor";
import { meshSnapshotsAsync } from "../../mesh/runtime";
import { publishedCatalog, recoverCatalogBindings } from "../../session-catalog";
import { recoverLocalGraphBindings } from "../../mesh/runtime/graph/binding-sync";
import { startSessionMonitor } from "../../monitor";
import { controllerPeerGate } from "../../pairing/controllers";
import { applyNetworkRoute } from "../../device-network/settings";
import { startEndpointPublisher } from "../../device-network/directory";
import { managedAdmissionOptions } from "../../managed-admission";

let client: RelayClient;
let monitor: ReturnType<typeof startSessionMonitor>;
const engine = new EngineSupervisor();
let stopping = false;
let stopEndpointPublisher = () => {};

try {
  const cfg = applyNetworkRoute(loadConfig(machineConfigPath()));
  client = new RelayClient(cfg, {
    ...managedAdmissionOptions(cfg),
    autoReconnect: true,
    replayPath: join(configDir(), `replay-${cfg.room}.json`),
    peerAllowed: controllerPeerGate(cfg),
  });
  monitor = startSessionMonitor(client);
  stopEndpointPublisher = startEndpointPublisher(cfg);
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
  stopEndpointPublisher();
  client.close();
  void engine.stop().finally(() => process.exit(0));
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

void recoverCatalogBindings({
  engineAvailable: async () => {
    const health = await engine.ensureAvailable();
    if (health.state !== "disabled" && health.state !== "healthy") {
      process.stderr.write(`[granttap-mcp] Project engine ${health.state}; legacy behavior remains active\n`);
    }
    return health.state === "healthy";
  },
  publishCatalog: async () => {
    try { await client.connect(); await monitor.publish(); }
    catch (error) {
      // RelayClient retries connection independently; keep this helper alive.
      process.stderr.write(`[granttap-mcp] initial catalog connection failed (${error instanceof Error ? error.name : "unknown"})\n`);
      throw error;
    }
  },
  snapshots: () => {
    const known = publishedCatalog(client);
    return meshSnapshotsAsync(known ? [...known.sessions, ...(known.history ?? [])] : []);
  },
  recover: recoverLocalGraphBindings,
}).then(() => monitor.publish()).catch(() => undefined);
