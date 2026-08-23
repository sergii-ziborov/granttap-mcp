import QRCode from "qrcode";
import { CODEX_TRUST_INSTRUCTION, type InstallResult } from "../install";
import { machineConfigPath, phonePairingPath } from "../config";
import { createOneTimePairing, DEFAULT_RELAY, PAIRING_CODE_TTL_MINUTES, reusablePairing } from "../pairing";

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

function codexHookLine(result: InstallResult): string {
  return `  ! Codex: action required — hooks ${result.status} (${result.detail}). ${CODEX_TRUST_INSTRUCTION}`;
}

async function connect(relayUrl: string): Promise<void> {
  const existing = reusablePairing();
  if (existing) {
    process.stdout.write([
      "GrantTap",
      "",
      "Phone pairing       Ready",
      "Background helper   Run granttap setup to verify",
      "",
      "Existing pairing reused. No QR or key rotation was needed.",
      "Use granttap reset before pairing this computer again.",
      "",
    ].join("\n"));
    return;
  }
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

  const skipHooks = pairing.cursor == null || pairing.claude == null || pairing.codex == null;
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
            hookLine("Cursor", pairing.cursor!),
            hookLine("Claude Code", pairing.claude!),
            codexHookLine(pairing.codex!),
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

function relayArgument(args: string[]): string {
  if (args.length === 0) return DEFAULT_RELAY;
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
    process.stdout.write("Usage: granttap connect [--relay <wss-url>]\n");
    process.exit(0);
  }
  if (args.length === 2 && args[0] === "--relay" && args[1]) return args[1];
  process.stderr.write("Usage: granttap connect [--relay <wss-url>]\n");
  process.exit(1);
}

const relayUrl = relayArgument(process.argv.slice(2));

void connect(relayUrl).catch((error: unknown) => {
  process.stderr.write(
    `[granttap-mcp] connect failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
