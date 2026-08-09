import {
  configuredCursorHttpMcpUrl,
  installCursorHttpConfig,
  validateCursorHttpConfig,
} from "../cursor-config";
import {
  httpMcpLaunchAgentPath,
  installHttpMcpService,
  isHttpMcpPortOccupied,
  probeHttpMcpHealth,
  restoreHttpMcpServiceAfterFailure,
  snapshotHttpMcpService,
  waitForHttpMcpHealth,
} from "../http-service";
import type { InstallResult } from "../../../bridge/src/install";
import { existsSync } from "node:fs";

async function authorize(): Promise<void> {
  const preflight = validateCursorHttpConfig();
  if (preflight) {
    throw new Error(`Cursor · Action required — ${preflight.detail}`);
  }
  const mcpUrl = configuredCursorHttpMcpUrl();
  const serviceBefore = snapshotHttpMcpService();
  const before = {
    configured: serviceBefore.configured,
    running: serviceBefore.configured && serviceBefore.running,
  };
  let repairAttempted = false;
  try {
    const alreadyHealthy = await probeHttpMcpHealth(mcpUrl, 400);
    let service: InstallResult;
    if (alreadyHealthy) {
      if (before.configured && before.running) {
        service = { status: "already", detail: httpMcpLaunchAgentPath() };
      } else if (existsSync(httpMcpLaunchAgentPath())) {
        repairAttempted = true;
        service = installHttpMcpService({ forceReload: true });
      } else {
        throw new Error(
          `a foreground or foreign service already owns ${mcpUrl}; stop it, then retry so GrantTap can install a persistent service`,
        );
      }
    } else {
      if (await isHttpMcpPortOccupied(mcpUrl)) {
        throw new Error(
          `another process owns ${new URL(mcpUrl).origin}; it was not stopped or replaced`,
        );
      }
      repairAttempted = true;
      service = installHttpMcpService({ forceReload: before.configured });
    }
    if (service.status === "manual") {
      throw new Error(`persistent OAuth service was not installed: ${service.detail}`);
    }
    const configuredTimeout = Number(process.env.GRANTTAP_HTTP_HEALTH_TIMEOUT_MS ?? 8_000);
    const healthTimeoutMs = Number.isFinite(configuredTimeout)
      ? Math.min(30_000, Math.max(100, configuredTimeout))
      : 8_000;
    if (!(await waitForHttpMcpHealth(mcpUrl, healthTimeoutMs))) {
      throw new Error(
        `persistent OAuth service did not become healthy at ${new URL("/healthz", mcpUrl).href}; Cursor config was not changed`,
      );
    }
    const cursor = installCursorHttpConfig(undefined, mcpUrl);
    if (cursor.status === "manual") {
      throw new Error(`Cursor · Action required — ${cursor.detail}`);
    }
    process.stderr.write(
      [
        `[granttap-mcp] Cursor · Configured — ${cursor.detail}`,
        `[granttap-mcp] Persistent local OAuth is healthy at ${mcpUrl}`,
        `[granttap-mcp] LaunchAgent: ${service.status} (${service.detail})`,
        "[granttap-mcp] Open Cursor Settings → MCP → GrantTap → Authorize.",
        "[granttap-mcp] If this Mac is not paired, the consent page shows a QR and manual token.",
        "",
      ].join("\n"),
    );
  } catch (error) {
    if (repairAttempted) restoreHttpMcpServiceAfterFailure(serviceBefore);
    throw error;
  }
}

void authorize().catch((error: unknown) => {
  process.stderr.write(
    `[granttap-mcp] authorize failed before Cursor config changed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
