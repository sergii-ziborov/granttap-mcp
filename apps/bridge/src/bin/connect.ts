import QRCode from "qrcode";
import type { InstallResult } from "../install";
import { machineConfigPath, phonePairingPath } from "../config";
import { createOneTimePairing, DEFAULT_RELAY, PAIRING_CODE_TTL_MINUTES } from "../pairing";

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
  const pairing = await createOneTimePairing(relayUrl);
  const qr = await QRCode.toString(pairing.qrPayload, {
    type: "terminal",
    small: true,
    errorCorrectionLevel: "L",
  });
  process.stdout.write(
    [
      "",
      "  Scan this one-time code in GrantTap on iPhone:",
      "",
      qr,
      "",
      "  Or paste this one-time secure token in the app:",
      "",
      `        ${pairing.manualToken}`,
      "",
      `  Relay: ${pairing.httpBase}`,
      `  The encrypted mailbox expires after ${PAIRING_CODE_TTL_MINUTES} minutes and can be used once.`,
      "  Its 256-bit key is never sent to the relay.",
      "",
    ].join("\n"),
  );

  const skipHooks = pairing.claude == null || pairing.codex == null;
  process.stdout.write(
    [
      "",
      "  GrantTap is paired on this machine.",
      "",
      `  room:        ${pairing.machineCfg.room}`,
      `  relay:       ${relayUrl}`,
      `  machine cfg: ${machineConfigPath()}`,
      `  phone cfg:   ${phonePairingPath()} (manual fallback; keep private)`,
      "",
      ...(skipHooks
        ? ["  Hooks: skipped (GRANTTAP_SKIP_HOOKS=1)"]
        : [
            hookLine("Claude Code", pairing.claude!),
            hookLine("Codex", pairing.codex!),
            hookLine("Background task sync", pairing.monitor!),
          ]),
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
