import QRCode from "qrcode";
import { generatePairingCode, sealWithCode } from "../../../../packages/core/crypto";
import { installClaudeHook, installCodexHook, type InstallResult } from "../install";
import {
  createPairing,
  machineConfigPath,
  pairingUri,
  phonePairingPath,
  saveConfig,
} from "../config";

const DEFAULT_RELAY = "wss://granttap-relay.sergii-ziborov.workers.dev";

function hookLine(name: string, result: InstallResult): string {
  switch (result.status) {
    case "installed":
      return `  ✓ ${name}: hook installed (${result.detail}; backup: .bak-granttap)`;
    case "already":
      return `  ✓ ${name}: hook already installed (${result.detail})`;
    case "manual":
      return `  ! ${name}: ${result.detail}`;
  }
}

async function connect(relayUrl: string): Promise<void> {
  const { machineCfg, phoneCfg } = createPairing(relayUrl);
  saveConfig(machineConfigPath(), machineCfg);
  saveConfig(phonePairingPath(), phoneCfg);

  const uri = pairingUri(phoneCfg);
  const qr = await QRCode.toString(uri, {
    type: "terminal",
    small: true,
    errorCorrectionLevel: "L",
  });
  process.stdout.write(["", "  Scan this code in GrantTap on iPhone:", "", qr].join("\n"));

  const code = generatePairingCode(8);
  const sealed = sealWithCode(phoneCfg, code);
  const httpBase = relayUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
  let codeReady = false;
  try {
    const response = await fetch(`${httpBase}/pair/${code}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sealed),
    });
    codeReady = response.ok;
  } catch {
    codeReady = false;
  }

  process.stdout.write(
    codeReady
      ? [
          "",
          "  Or enter this one-time code in the app:",
          "",
          `        ${code.slice(0, 4)} ${code.slice(4)}`,
          "",
          `  Relay: ${httpBase}`,
          "  The code expires after 15 minutes and can be used once.",
          "",
        ].join("\n")
      : [
          "",
          `  ! The relay at ${httpBase} did not accept a short code.`,
          "    The QR still works. Check the relay and retry for code pairing.",
          "",
        ].join("\n"),
  );

  const skipHooks = process.env.GRANTTAP_SKIP_HOOKS === "1";
  const claude = skipHooks ? null : installClaudeHook();
  const codex = skipHooks ? null : installCodexHook();
  process.stdout.write(
    [
      "",
      "  GrantTap is paired on this machine.",
      "",
      `  room:        ${machineCfg.room}`,
      `  relay:       ${relayUrl}`,
      `  machine cfg: ${machineConfigPath()}`,
      `  phone cfg:   ${phonePairingPath()} (manual fallback; keep private)`,
      "",
      ...(skipHooks
        ? ["  Hooks: skipped (GRANTTAP_SKIP_HOOKS=1)"]
        : [hookLine("Claude Code", claude!), hookLine("Codex", codex!)]),
      "",
      "  Keep the MCP server configured in your agent. Approval requests now",
      "  use the paired phone and watch; if the relay is unavailable, hooks fall",
      "  back to the agent's normal local approval flow.",
      "",
    ].join("\n"),
  );
}

const relayUrl =
  process.argv[2] ??
  process.env.GRANTTAP_RELAY_URL ??
  process.env.NODVOX_RELAY_URL ??
  DEFAULT_RELAY;

void connect(relayUrl).catch((error: unknown) => {
  process.stderr.write(
    `[granttap-mcp] connect failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
