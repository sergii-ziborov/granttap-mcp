import { refreshCodexHooks, codexHooksReady } from "../../codex-hook-trust";
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
} from "../../install";
import { createOneTimePairing, DEFAULT_RELAY, PAIRING_CODE_TTL_MINUTES } from "../../pairing";
import { prepareSetupEngine, type SetupEngine } from "../../engine/distribution";
import { usableEngineBinary } from "../../engine/protocol/engine-declaration";
import { isMachineConfigured } from "../../../../mcp/src/status/pairing-status";
import { removeCursorUserGrantTap } from "../../../../mcp/src/cursor-config";
import { installHttpMcpService, waitForHttpMcpHealth } from "../../../../mcp/src/http-service";

const SETUP_USAGE = [
  "Usage: granttap setup [--engine <path>]",
  "",
  "Detects local coding agents, installs or repairs their GrantTap hooks, the background",
  "helper and the local MCP service, prepares the Graph Engine, and starts phone pairing",
  "when run in an interactive terminal. Without an Engine, everything else is still set up.",
  "",
  "Options:",
  "  --engine <path>  Use this absolute path to an executable as the Engine",
  "  -h, --help       Show this help without changing anything",
  "",
].join("\n");

/** Argument mistakes stop setup before it changes any provider configuration. */
function engineArgument(args: string[]): string | undefined {
  const flag = args.indexOf("--engine");
  if (flag < 0) return undefined;
  const path = args[flag + 1];
  if (!path) throw new Error("Choose an executable after --engine");
  if (!usableEngineBinary(path)) throw new Error("The selected Engine must be an absolute path to an executable regular file");
  return path;
}

function engineNote(engine: SetupEngine): string[] {
  if (!engine.reason) return [];
  return [engine.declaration
    ? `Engine not prepared: ${engine.reason}. Using the verified Engine already installed on this computer.`
    : `Graph Engine unavailable on this computer: ${engine.reason}. Graph and Project Governance stay off.`];
}

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
  const explicitEngine = engineArgument(process.argv.slice(2));
  const before = {
    cursor: inspectCursorIntegration(),
    agents: inspectAgentIntegrations(),
  };
  const cursorHook = installCursorHook();
  const claudeHook = installClaudeHook();
  const codexHook = installCodexHook();
  // Declared before the helper is written, so the LaunchAgent picks the engine
  // up in the same run rather than needing a second one. A missing Engine never
  // stops the helper, HTTP service, Codex trust or pairing below.
  const engine = await prepareSetupEngine(explicitEngine);
  const helper = installMonitorHelper();
  let httpService: InstallResult | null = null;
  let cursorConfig: InstallResult | null = null;
  const mcpClientInstalled = before.agents.some((item) => item.installed);
  if (before.cursor.installed || mcpClientInstalled) {
    httpService = installHttpMcpService({ forceReload: true });
    if (process.platform === "win32" && httpService.status !== "manual"
      && !await waitForHttpMcpHealth(undefined, 15_000)) {
      httpService = { status: "manual", detail: "Windows background service did not become healthy." };
    }
    if (before.cursor.installed && httpService.status !== "manual") {
      cursorConfig = removeCursorUserGrantTap();
    }
  }
  const codexTrust = await refreshCodexHooks(true);
  const pairingResult = await pairIfNeeded();
  const paired = isMachineConfigured();
  const installed = new Set(before.agents.filter((item) => item.installed).map((item) => item.agent));
  const cursorReady = cursorHook.status !== "manual"
    && (!before.cursor.installed
      || (httpService?.status !== "manual" && cursorConfig?.status !== "manual"));

  process.stdout.write([
    "GrantTap",
    "",
    `Phone pairing       ${paired ? "Ready" : pairingResult === "failed" ? "Relay unavailable" : "Needs connection"}`,
    `Background helper   ${state(helper)}`,
    "",
    `Claude Code         ${installed.has("claude")
      ? claudeHook.status === "manual" || httpService?.status === "manual"
        ? "Needs attention" : "Authorize in Claude Code" : "Not installed"}`,
    `Codex               ${installed.has("codex")
      ? codexHook.status === "manual" || httpService?.status === "manual"
        ? "Needs attention" : !paired ? "Needs connection" : codexHooksReady(codexTrust.hooks) ? "Hooks trusted and enabled" : "Authorize in Codex; review hooks"
      : "Not installed"}`,
    `Cursor              ${before.cursor.installed ? `Beta · ${cursorReady ? "Use GrantTap plugin" : "Needs repair"}` : "Not installed"}`,
    `Grok Build          ${installed.has("grok")
      ? httpService?.status === "manual" ? "Needs attention" : "Authorize in Grok Build"
      : "Not installed"}`,
    // Governance is edited on the phone but cannot report until an engine is
    // declared here, so say plainly which of the two is missing.
    `Project Governance  ${engine.declaration ? "Ready" : "No engine found"}`,
    "",
    ...engineNote(engine),
    paired && installed.has("codex")
      ? codexHooksReady(codexTrust.hooks) ? "Codex confirmed both GrantTap hooks are trusted and enabled."
        : `Next: review GrantTap hooks in GrantTap Settings → This Mac → Codex hooks, or ${CODEX_TRUST_INSTRUCTION}`
      : paired && before.cursor.installed
        ? "Next: keep the GrantTap plugin. Pair and change settings in the GrantTap app, not Cursor MCP settings."
        : !paired
          ? "Next: pair from the GrantTap plugin connection card or the GrantTap app."
          : "Ready. Continue from GrantTap on your controller device.",
    "",
  ].join("\n"));
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(SETUP_USAGE);
} else {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `[granttap-mcp] setup failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
