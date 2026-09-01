import QRCode from "qrcode";
import {
  CODEX_TRUST_INSTRUCTION,
  inspectAgentIntegrations,
  inspectCursorIntegration,
  installClaudeHook,
  installCodexHook,
  installCursorHook,
  installMonitorHelper,
  type InstallResult,
} from "../install";
import { createOneTimePairing, DEFAULT_RELAY, PAIRING_CODE_TTL_MINUTES } from "../pairing";
import { declareEngine } from "../engine/engine-declaration";
import { isMachineConfigured } from "../../../mcp/src/pairing-status";
import { installCursorHttpConfig } from "../../../mcp/src/cursor-config";
import { installHttpMcpService } from "../../../mcp/src/http-service";

function state(result: InstallResult): string {
  return result.status === "manual" ? "Needs attention" : "Ready";
}

async function pairIfNeeded(): Promise<string | null> {
  if (isMachineConfigured()) return null;
  const interactive = process.stdout.isTTY || process.env.GRANTTAP_SETUP_PAIRING === "1";
  if (!interactive || process.env.GRANTTAP_SKIP_PAIRING === "1") return null;
  try {
    const pairing = await createOneTimePairing(
      process.env.GRANTTAP_TEST_RELAY_URL ?? DEFAULT_RELAY,
      { installHooks: false },
    );
    const qr = await QRCode.toString(pairing.qrPayload, {
      type: "terminal",
      small: true,
      errorCorrectionLevel: "L",
    });
    process.stdout.write([
      "",
      "Scan this one-time QR in GrantTap on iPhone:",
      "",
      qr,
      `Expires in ${PAIRING_CODE_TTL_MINUTES} minutes. The transfer key is not sent to the relay.`,
      "",
    ].join("\n"));
    return "paired";
  } catch {
    return "failed";
  }
}

async function main(): Promise<void> {
  const before = {
    cursor: inspectCursorIntegration(),
    agents: inspectAgentIntegrations(),
  };
  const cursorHook = installCursorHook();
  const claudeHook = installClaudeHook();
  const codexHook = installCodexHook();
  // Declared before the helper is written, so the LaunchAgent picks the engine
  // up in the same run rather than needing a second one.
  const engineFlag = process.argv.indexOf("--engine");
  const engine = declareEngine(
    engineFlag >= 0 ? process.argv[engineFlag + 1] : undefined,
  );
  const helper = installMonitorHelper();
  let cursorService: InstallResult | null = null;
  let cursorConfig: InstallResult | null = null;
  if (before.cursor.installed) {
    cursorService = installHttpMcpService();
    if (cursorService.status !== "manual") cursorConfig = installCursorHttpConfig();
  }
  const pairingResult = await pairIfNeeded();
  const paired = isMachineConfigured();
  const installed = new Set(before.agents.filter((item) => item.installed).map((item) => item.agent));
  const cursorReady = cursorHook.status !== "manual"
    && (!before.cursor.installed
      || (cursorService?.status !== "manual" && cursorConfig?.status !== "manual"));

  process.stdout.write([
    "GrantTap",
    "",
    `Phone pairing       ${paired ? "Ready" : pairingResult === "failed" ? "Relay unavailable" : "Needs connection"}`,
    `Background helper   ${state(helper)}`,
    "",
    `Claude Code         ${installed.has("claude") ? state(claudeHook) : "Not installed"}`,
    `Codex               ${installed.has("codex")
      ? codexHook.status === "manual" ? "Needs attention" : "Needs hook trust"
      : "Not installed"}`,
    `Cursor              ${before.cursor.installed ? `Beta · ${cursorReady ? "Authorize in Cursor" : "Needs repair"}` : "Not installed"}`,
    `Grok Build          ${installed.has("grok") ? "Ready" : "Not installed"}`,
    // Governance is edited on the phone but cannot report until an engine is
    // declared here, so say plainly which of the two is missing.
    `Project Governance  ${engine ? "Ready" : "No engine found"}`,
    "",
    paired && installed.has("codex")
      ? `Next: ${CODEX_TRUST_INSTRUCTION}`
      : paired && before.cursor.installed
        ? "Next: open Cursor Settings → MCP → GrantTap → Authorize."
        : !paired
          ? "Next: run granttap connect."
          : engine
            ? "Governance is live. Restart the helper to pick it up: launchctl kickstart -k gui/$(id -u)/com.granttap.monitor"
            : "Governance stays off until an engine is found. Point at one with: granttap setup --engine <path>",
    "",
  ].join("\n"));
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `[granttap-mcp] setup failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
