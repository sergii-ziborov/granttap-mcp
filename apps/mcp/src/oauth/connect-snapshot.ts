/**
 * Public consent snapshot for granttap.com. No pairing keys, tokens, or codes.
 */
import { hostname } from "node:os";
import { inspectAgentIntegrations } from "../../../bridge/src/install";
import { loadConfig } from "../../../bridge/src/config";
import { computerId } from "../../../bridge/src/mesh/computer-identity";
import { isTerminalTaskState } from "../../../bridge/src/mesh/convergence";
import { localMeshStore } from "../../../bridge/src/mesh/local";
import { connectionRuntimeStatus } from "../mcp-tools/relay";
import { isMachineConfigured, listPairedPhones, readOnlyMachineConfigPath } from "../pairing-status";

export type ConnectProvider = {
  id: "codex" | "claude" | "cursor";
  installed: boolean;
  ready: boolean;
};

export type ConnectMesh = {
  present: boolean;
  thisComputer: string;
  computers: string[];
  openTasks: number;
};

export type ConnectSnapshot = {
  clientName: string;
  computerName: string;
  paired: boolean;
  phones: ReturnType<typeof listPairedPhones>;
  providers: ConnectProvider[];
  relayStatus: "online" | "offline" | "unknown";
  mesh: ConnectMesh;
};

export function publicClientName(name: string | undefined): string {
  return name?.trim().slice(0, 80) || "Coding app";
}

export function buildConnectSnapshot(clientName?: string): ConnectSnapshot {
  const paired = isMachineConfigured();
  const runtime = connectionRuntimeStatus(
    paired ? loadConfig(readOnlyMachineConfigPath()).room : undefined,
  );
  return {
    clientName: publicClientName(clientName),
    computerName: hostname(),
    paired,
    phones: listPairedPhones(runtime.phoneLastSeenAt),
    providers: inspectAgentIntegrations()
      .filter((item): item is typeof item & { agent: ConnectProvider["id"] } =>
        item.agent === "codex" || item.agent === "claude" || item.agent === "cursor")
      .map((item) => ({
        id: item.agent,
        installed: item.installed,
        ready: item.hookConfigured,
      })),
    relayStatus: runtime.relayStatus,
    mesh: publicMeshSummary(),
  };
}

/** Computers and open tasks only. No transcripts, keys, or room ids. */
export function publicMeshSummary(): ConnectMesh {
  const thisComputer = hostname().trim().slice(0, 80) || "This Mac";
  try {
    const store = localMeshStore();
    const names = new Set<string>([thisComputer, computerId().slice(0, 80)]);
    let openTasks = 0;
    for (const projectId of store.projectIds().slice(0, 16)) {
      const snapshot = store.snapshot(projectId);
      if (!snapshot) continue;
      openTasks += snapshot.tasks.filter((task) => !isTerminalTaskState(task.state)).length;
      for (const execution of snapshot.executions) {
        if (execution.endedAt != null) continue;
        const name = execution.computerId.trim().slice(0, 80);
        if (name) names.add(name);
      }
    }
    return {
      present: store.projectIds().length > 0,
      thisComputer,
      computers: [...names].slice(0, 8),
      openTasks,
    };
  } catch {
    return { present: false, thisComputer, computers: [thisComputer], openTasks: 0 };
  }
}
