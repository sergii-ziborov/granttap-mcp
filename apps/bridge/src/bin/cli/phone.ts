import QRCode from "qrcode";
import { loadConfig } from "../../config";
import { reloadPairingHelper } from "../../install";
import { createOneTimePairing, DEFAULT_RELAY, PAIRING_CODE_TTL_MINUTES } from "../../pairing";
import { isMachineConfigured, readOnlyMachineConfigPath } from "../../../../mcp/src/status/pairing-status";
import { installHttpMcpService } from "../../../../mcp/src/http-service";

const mode = process.argv[2];

async function main(): Promise<void> {
  if (mode !== "add" && mode !== "reconnect") {
    process.stderr.write("Usage: granttap phone add|reconnect\n");
    process.exitCode = 1;
    return;
  }
  if (!process.stdout.isTTY) {
    process.stderr.write("Open an interactive terminal and run this command yourself; the private pairing QR is never written to agent logs.\n");
    process.exitCode = 1;
    return;
  }
  const paired = isMachineConfigured();
  if (!paired && mode === "reconnect") {
    process.stderr.write("This computer has no saved pairing. Run granttap phone add instead.\n");
    process.exitCode = 1;
    return;
  }
  const relay = paired ? loadConfig(readOnlyMachineConfigPath()).relayUrl : DEFAULT_RELAY;
  const result = await createOneTimePairing(relay, {
    addController: paired && mode === "add",
    installHooks: false,
  });
  const helper = reloadPairingHelper({ firstPairing: !paired });
  const mcp = installHttpMcpService({ forceReload: true });
  const qr = await QRCode.toString(result.qrPayload, {
    type: "terminal", small: true, errorCorrectionLevel: "L",
  });
  process.stdout.write([
    "",
    mode === "add" ? "Add a controller iPhone or iPad" : "Reconnect the same controller phone",
    "Open GrantTap on the phone → Settings → Connections → Add a device (Scan QR).",
    "",
    qr,
    "",
    `The QR expires in ${PAIRING_CODE_TTL_MINUTES} minutes. Never paste it into chat.`,
    ...(helper?.status === "manual" || mcp.status === "manual"
      ? ["Background connection needs attention. Run granttap setup after scanning."] : []),
    "",
  ].join("\n"));
}

void main().catch((error: unknown) => {
  process.stderr.write(`GrantTap could not issue a phone QR: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
