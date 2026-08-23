import {
  CODEX_TRUST_INSTRUCTION,
  inspectAgentIntegrations,
  inspectCursorIntegration,
  inspectMonitorHelper,
  type AgentIntegrationStatus,
  type CursorIntegrationStatus,
  type MonitorIntegrationStatus,
} from "../../bridge/src/install";
import { isMachineConfigured } from "./pairing-status";
import { isCursorHttpMcpConfigured } from "./cursor-config";
import { inspectHttpMcpService, probeHttpMcpHealth } from "./http-service";

export type ProviderId = "cursor" | "claude" | "codex" | "grok";
export type ProviderConnectionState = "connected" | "action_required" | "not_configured";

export type ProviderConnectionStatus = {
  id: ProviderId;
  status: ProviderConnectionState;
  detail: string;
};

export type ProviderStatusSnapshot = {
  schema: "granttap.provider-status.v1";
  generatedAt: string;
  providers: ProviderConnectionStatus[];
};

export type ProviderReadiness = {
  cursor: CursorIntegrationStatus;
  integrations: AgentIntegrationStatus[];
  paired: boolean;
  monitor: MonitorIntegrationStatus;
  cursorOAuth?: CursorOAuthReadiness;
};

export type CursorOAuthReadiness = {
  configured: boolean;
  persistent: boolean;
  healthy: boolean;
};

function runtimeRequirement(
  id: ProviderId,
  readiness: ProviderReadiness,
): ProviderConnectionStatus | null {
  if (!readiness.paired) {
    return {
      id,
      status: "action_required",
      detail: "Local provider integration found, but this computer is not paired. Run granttap connect.",
    };
  }
  if (!readiness.monitor.configured) {
    return {
      id,
      status: "action_required",
      detail: "Provider integration and pairing found, but background sync is not configured. Run granttap setup.",
    };
  }
  if (!readiness.monitor.running) {
    return {
      id,
      status: "action_required",
      detail: "Background sync is configured but not running. Run granttap setup to repair it.",
    };
  }
  return null;
}

function cursorStatus(readiness: ProviderReadiness): ProviderConnectionStatus {
  if (!readiness.cursor.hookConfigured) {
    return {
      id: "cursor",
      status: readiness.cursor.installed ? "action_required" : "not_configured",
      detail: "Run granttap setup to install or repair Cursor shell and MCP policy hooks.",
    };
  }
  const runtime = runtimeRequirement("cursor", readiness);
  if (runtime) return runtime;
  if (readiness.cursorOAuth?.configured
    && (!readiness.cursorOAuth.persistent || !readiness.cursorOAuth.healthy)) {
    return {
      id: "cursor",
      status: "action_required",
      detail: "Cursor's local authorization service needs repair. Run granttap cursor repair.",
    };
  }
  return {
    id: "cursor",
    status: "connected",
    detail: readiness.cursorOAuth?.configured
      ? "Shell/MCP policy hooks, pairing, background sync, and the persistent OAuth endpoint are ready."
      : "Shell/MCP policy hooks, pairing, and background sync are ready. Run granttap setup for Cursor authorization.",
  };
}

function agentStatus(
  agent: "claude" | "codex",
  readiness: ProviderReadiness,
): ProviderConnectionStatus {
  const integration = readiness.integrations.find((row) => row.agent === agent);
  const label = agent === "claude" ? "Claude Code" : "Codex";
  if (!integration?.installed && !integration?.hookConfigured) {
    return {
      id: agent,
      status: "not_configured",
      detail: `Install ${label}, then run granttap setup.`,
    };
  }
  if (!integration?.installed) {
    return {
      id: agent,
      status: "action_required",
      detail: `${label} hook exists, but its CLI is unavailable on PATH.`,
    };
  }
  if (!integration.hookConfigured) {
    return {
      id: agent,
      status: "action_required",
      detail: `Run granttap setup to install the ${label} approval hook.`,
    };
  }
  const runtime = runtimeRequirement(agent, readiness);
  if (runtime) return runtime;
  if (agent === "codex") {
    return {
      id: agent,
      status: "action_required",
      detail: CODEX_TRUST_INSTRUCTION,
    };
  }
  return {
    id: agent,
    status: "connected",
    detail: "CLI, approval hook, pairing, and background sync are ready.",
  };
}

function grokStatus(readiness: ProviderReadiness): ProviderConnectionStatus {
  const integration = readiness.integrations.find((row) => row.agent === "grok");
  if (!integration?.installed) return {
    id: "grok", status: "not_configured",
    detail: "Install Grok Build, then run granttap setup.",
  };
  const runtime = runtimeRequirement("grok", readiness);
  if (runtime) return runtime;
  return {
    id: "grok", status: "connected",
    detail: "CLI session discovery, continuation, pairing, and background sync are ready.",
  };
}

export function providerStatuses(readiness: ProviderReadiness): ProviderConnectionStatus[] {
  return [
    cursorStatus(readiness),
    agentStatus("claude", readiness),
    agentStatus("codex", readiness),
    grokStatus(readiness),
  ];
}

export function inspectProviderStatusSnapshot(
  now: Date = new Date(),
  cursorOAuth: CursorOAuthReadiness = { configured: false, persistent: false, healthy: false },
): ProviderStatusSnapshot {
  return {
    schema: "granttap.provider-status.v1",
    generatedAt: now.toISOString(),
    providers: providerStatuses({
      cursor: inspectCursorIntegration(),
      integrations: inspectAgentIntegrations(),
      paired: isMachineConfigured(),
      monitor: inspectMonitorHelper(),
      cursorOAuth,
    }),
  };
}

/** Exact configured URL + persistent service + live GrantTap health identity. */
export async function inspectCursorOAuthReadiness(): Promise<CursorOAuthReadiness> {
  if (!isCursorHttpMcpConfigured()) {
    return { configured: false, persistent: false, healthy: false };
  }
  const service = inspectHttpMcpService();
  return {
    configured: true,
    persistent: service.configured && service.running,
    healthy: await probeHttpMcpHealth(),
  };
}
