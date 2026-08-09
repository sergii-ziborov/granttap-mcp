import {
  CODEX_TRUST_INSTRUCTION,
  inspectAgentIntegrations,
  inspectCursorIntegration,
  inspectMonitorHelper,
  type AgentIntegrationStatus,
  type CursorIntegrationStatus,
  type MonitorIntegrationStatus,
} from "../../bridge/src/install";
import {
  listCloudApprovals,
  validatedCloudPageUrl,
} from "../../bridge/src/cloud-approvals";
import { loadConfig } from "../../bridge/src/config";
import { isMachineConfigured, readOnlyMachineConfigPath } from "./pairing-status";
import { isCursorHttpMcpConfigured } from "./cursor-config";
import { inspectHttpMcpService, probeHttpMcpHealth } from "./http-service";

export type ProviderId = "cursor" | "claude" | "codex" | "web";
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
  web?: WebReadiness;
  cursorOAuth?: CursorOAuthReadiness;
};

export type CursorOAuthReadiness = {
  configured: boolean;
  persistent: boolean;
  healthy: boolean;
};

export type WebReadiness = {
  /** A well-formed relay capability exists in machine.json. */
  configured: boolean;
  /** The authenticated relay endpoint answered with a private page capability. */
  reachable: boolean;
};

function runtimeRequirement(
  id: "cursor" | "claude" | "codex",
  readiness: ProviderReadiness,
): ProviderConnectionStatus | null {
  if (!readiness.paired) {
    return {
      id,
      status: "action_required",
      detail: "Hooks installed, but this Mac is not paired. Run granttap connect.",
    };
  }
  if (!readiness.monitor.configured) {
    return {
      id,
      status: "action_required",
      detail: "Hooks and pairing found, but background sync is not configured. Run granttap setup.",
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
      detail: "Cursor OAuth is configured but its persistent loopback service is not healthy. Run granttap authorize.",
    };
  }
  return {
    id: "cursor",
    status: "connected",
    detail: readiness.cursorOAuth?.configured
      ? "Shell/MCP policy hooks, pairing, background sync, and the persistent OAuth endpoint are ready."
      : "Shell/MCP policy hooks, pairing, and background sync are ready. OAuth remains optional via granttap authorize.",
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

export function providerStatuses(readiness: ProviderReadiness): ProviderConnectionStatus[] {
  const web = readiness.web ?? { configured: false, reachable: false };
  return [
    cursorStatus(readiness),
    agentStatus("claude", readiness),
    agentStatus("codex", readiness),
    web.reachable
      ? {
          id: "web",
          status: "connected",
          detail: "The private approval capability is available. Run granttap web to reveal it.",
        }
      : web.configured
        ? {
            id: "web",
            status: "action_required",
            detail: "The private Web capability is configured, but the relay did not answer. Check the relay and retry granttap web.",
          }
        : {
            id: "web",
            status: "not_configured",
            detail: "Run granttap connect before adding GrantTap Web.",
          },
  ];
}

export function inspectProviderStatusSnapshot(
  now: Date = new Date(),
  web: WebReadiness = { configured: false, reachable: false },
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
      web,
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

/**
 * Make a bounded authenticated GET probe without returning its bearer URL or
 * any relay error body to status callers.
 */
export async function inspectWebReadiness(
  fetchImpl: typeof fetch = fetch,
): Promise<WebReadiness> {
  let config;
  try {
    config = loadConfig(readOnlyMachineConfigPath());
  } catch {
    return { configured: false, reachable: false };
  }
  const configured = isMachineConfigured()
    && typeof config.pushAuth === "string"
    && /^[a-f0-9]{64}$/.test(config.pushAuth);
  if (!configured) return { configured: false, reachable: false };
  try {
    const result = await listCloudApprovals(config, fetchImpl);
    return {
      configured: true,
      reachable: result.ok
        && validatedCloudPageUrl(config.relayUrl, result.pageUrl) != null,
    };
  } catch {
    return { configured: true, reachable: false };
  }
}
