import QRCode from "qrcode";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createOneTimePairing, DEFAULT_RELAY, PAIRING_CODE_TTL_MINUTES, reusablePairing } from "../../../bridge/src/pairing";
import { CONNECTION_WIDGET_URI } from "./connection-widget";
import { resetRelay, relay } from "./relay";

const connectionOutput = {
  status: z.enum(["connected", "pairing"]),
  relay: z.string(),
  expiresInMinutes: z.number().int().positive().nullable(),
};

const widgetMeta = {
  ui: { resourceUri: CONNECTION_WIDGET_URI },
  "openai/outputTemplate": CONNECTION_WIDGET_URI,
  "openai/toolInvocation/invoking": "Opening GrantTap…",
  "openai/toolInvocation/invoked": "GrantTap is ready.",
};

const changes = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

export function registerConnectTool(server: McpServer): void {
  server.registerTool(
    "connect",
    {
      description: "Reuse this computer's GrantTap pairing, or create a one-time QR when none exists.",
      inputSchema: {},
      outputSchema: connectionOutput,
      annotations: changes,
      _meta: widgetMeta,
    },
    async (): Promise<CallToolResult> => connect(),
  );
  server.registerTool(
    "reconnect",
    {
      description: "Replace this computer's current GrantTap pairing and create a fresh one-time QR. Requires explicit confirmation.",
      inputSchema: { confirmed: z.boolean().describe("True only after the user confirms replacing the current pairing") },
      outputSchema: connectionOutput,
      annotations: { ...changes, destructiveHint: true },
      _meta: widgetMeta,
    },
    async ({ confirmed }): Promise<CallToolResult> => confirmed
      ? connect(true)
      : ({ isError: true, content: [{ type: "text", text: "Reconnect cancelled: explicit confirmation is required." }] }),
  );
}

async function connect(replace = false): Promise<CallToolResult> {
  try {
    const existing = reusablePairing(replace);
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
    structuredContent: {
      status: "connected",
      relay: relayLabel(pairing.relayUrl),
      expiresInMinutes: null,
    },
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
    structuredContent: {
      status: "pairing",
      relay: relayLabel(pairing.machineCfg.relayUrl),
      expiresInMinutes: PAIRING_CODE_TTL_MINUTES,
    },
    _meta: {
      granttap: {
        qrDataUrl: `data:image/png;base64,${png.toString("base64")}`,
        pairingUri: pairing.qrPayload,
      },
    },
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

function relayLabel(relayUrl: string): string {
  return new URL(relayUrl).host;
}
