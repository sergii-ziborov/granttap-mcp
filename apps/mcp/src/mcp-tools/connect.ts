import QRCode from "qrcode";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createOneTimePairing, DEFAULT_RELAY, PAIRING_CODE_TTL_MINUTES, reusablePairing } from "../../../bridge/src/pairing";
import { resetRelay, relay } from "./relay";

export function registerConnectTool(server: McpServer): void {
  server.registerTool(
    "connect",
    {
      description: "Reuse this computer's GrantTap pairing, or create a one-time QR when none exists.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (): Promise<CallToolResult> => connect(),
  );
}

async function connect(): Promise<CallToolResult> {
  try {
    const existing = reusablePairing();
    if (existing) return reusedPairingResult(existing);
    return await oneTimePairingResult();
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: `GrantTap pairing could not be created: ${error instanceof Error ? error.message : String(error)}` }],
    };
  }
}

function reusedPairingResult(pairing: { room: string; relayUrl: string }): CallToolResult {
  return {
    content: [{
      type: "text",
      text: [
        "GrantTap existing secure pairing reused.",
        `Room: ${pairing.room}`,
        `Relay: ${pairing.relayUrl}`,
        "No QR or key rotation was needed.",
      ].join("\n"),
      annotations: { audience: ["user"] },
    }],
  };
}

async function oneTimePairingResult(): Promise<CallToolResult> {
  const pairing = await createOneTimePairing(
    process.env.GRANTTAP_TEST_RELAY_URL ?? DEFAULT_RELAY,
  );
  resetRelay();
  void relay();
  const png = await QRCode.toBuffer(pairing.qrPayload, {
    type: "png", width: 900, margin: 4, errorCorrectionLevel: "L",
  });
  return {
    content: [
      {
        type: "text",
        text: [
          "Pair this Mac with GrantTap (QR optional — paste is enough):",
          "",
          "PASTE THIS in GrantTap → Settings → Connections → Paste / Add computer:",
          pairing.qrPayload,
          "",
          `Relay: ${pairing.httpBase}`,
          `One-time link — expires in ${PAIRING_CODE_TTL_MINUTES} minutes.`,
          "Also on Desktop: GrantTap-pair-uri.txt (when connect writes it).",
        ].join("\n"),
        annotations: { audience: ["user"] },
      },
      { type: "image", data: png.toString("base64"), mimeType: "image/png", annotations: { audience: ["user"] } },
    ],
  };
}
