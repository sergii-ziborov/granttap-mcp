import { startRuntimeUpdates } from "../../runtime-updates";
import { runtimeUpdateReadiness } from "../../runtime-updates/readiness";
/** Persistent, terminal-free task sync for the GrantTap phone app on macOS. */
import { join } from "node:path";
import { RelayClient } from "../../../../../packages/core/relay-client";
import { configDir, loadConfig, machineConfigPath } from "../../config";
import { EngineSupervisor } from "../../engine/runtime/engine-supervisor";
import { prepareMonitorEngine } from "../../engine/distribution";
import { startEngineRecovery } from "../../engine/startup";
import { meshSnapshotsAsync } from "../../mesh/runtime";
import { publishedCatalog } from "../../session-catalog";
import { recoverLocalGraphBindings } from "../../mesh/runtime/graph/binding-sync";
import { startSessionMonitor } from "../../monitor";
import { controllerPeerGate } from "../../pairing/controllers";
import { applyNetworkRoute } from "../../device-network/settings";
import { startEndpointPublisher } from "../../device-network/directory";
import { managedAdmissionOptions } from "../../managed-admission";
import { publishStableNode } from "../../install/stable-node/index";
import { startRuntimeWatchdog } from "../../runtime-watchdog";

import { startTaskDispatchMonitor } from "../../task-dispatch/worker/monitor";
import { startTaskNetworkMonitor } from '../../task-network/runtime';
import { claimLinkRestart } from '../../monitor/support/link-restart';

let client: RelayClient;
let monitor: ReturnType<typeof startSessionMonitor>;
const engine = new EngineSupervisor();
let stopping = false;
let stopEndpointPublisher = () => {};
let stopTaskDispatch = () => {};
let stopTaskNetwork = () => {};
let stopEngineRecovery = () => {};
let stopRuntimeUpdates = () => {};
let stopUpdateReadiness = () => {};
const stopWatchdog = startRuntimeWatchdog();

publishStableNode();

try {
  const cfg = applyNetworkRoute(loadConfig(machineConfigPath()));
  client = new RelayClient(cfg, {
    ...managedAdmissionOptions(cfg),
    autoReconnect: true,
    replayPath: join(configDir(), `replay-${cfg.room}.json`),
    peerAllowed: controllerPeerGate(cfg),
  });
  monitor = startSessionMonitor(client, { primary: process.env.GRANTTAP_MONITOR_PRIMARY === "1" });
  stopTaskDispatch = startTaskDispatchMonitor({ config: cfg, client,
    isLeader: monitor.isLeader, peerAllowed: controllerPeerGate(cfg), publish: monitor.publish });
  stopTaskNetwork = startTaskNetworkMonitor({ config: cfg, client,
    isLeader: monitor.isLeader, peerAllowed: controllerPeerGate(cfg), publish: monitor.publish });
  stopEndpointPublisher = startEndpointPublisher(cfg);
  stopRuntimeUpdates = startRuntimeUpdates(monitor.canUpdate);
  stopUpdateReadiness = runtimeUpdateReadiness(monitor.canUpdate);
} catch (error) {
  process.stderr.write(
    `[granttap-mcp] monitor is not paired: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}

const stop = (exitCode = 0): void => {
  if (stopping) return;
  stopping = true;
  stopWatchdog();
  stopRuntimeUpdates();
  stopUpdateReadiness();
  stopEngineRecovery();
  stopTaskDispatch();
  stopTaskNetwork();
  monitor.close();
  stopEndpointPublisher();
  client.close();
  void engine.stop().finally(() => process.exit(exitCode));
};

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
// A monitor that cannot stay on the relay looks online on the phone while no message reaches it.
client.onLinkStuck(report => {
  process.stderr.write(`[monitor] cannot stay on the relay: ${report.failures} failures in five minutes, last ${report.reason}\n`);
  if (claimLinkRestart()) {
    process.stderr.write("[monitor] restarting for a fresh relay link\n");
    stop(75);
  }
});

stopEngineRecovery = startEngineRecovery({
  prepare: prepareMonitorEngine,
  available: async () => {
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
  recover: async () => {
    const known = publishedCatalog(client);
    const snapshots = await meshSnapshotsAsync(known ? [...known.sessions, ...(known.history ?? [])] : []);
    await recoverLocalGraphBindings(snapshots);
    await monitor.publish();
  },
  failed: error => {
    process.stderr.write(`[granttap-mcp] Engine recovery will retry (${error instanceof Error ? error.name : "unknown"})\n`);
  },
});
