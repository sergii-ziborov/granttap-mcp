import QRCode from "qrcode";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createOneTimePairing, DEFAULT_RELAY, PAIRING_CODE_TTL_MINUTES } from "../../../bridge/src/pairing";
import { isMachineConfigured } from "../pairing-status";
import { ConnectionState, connectionOutput } from "../connection-center/state";
import { CONNECTION_WIDGET_URI } from "./connection-widget";
import { resetRelay, relay } from "./relay";

const widgetMeta = {
  ui: { resourceUri: CONNECTION_WIDGET_URI, visibility: ["model", "app"] },
  "openai/widgetAccessible": true,
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
  const state = new ConnectionState();
  let pendingCall: Promise<CallToolResult> | null = null;
  const perform = (replace = false) => {
    if (pendingCall) return pendingCall;
    pendingCall = connect(state, replace).finally(() => { pendingCall = null; });
    return pendingCall;
  };
  server.registerTool("connection_status", {
    title: "GrantTap connection center",
    description: "Open connection controls and inspect pairing, QR expiry, this computer, relay observations and provider readiness. Does not create or replace pairing.",
    inputSchema: {},
    outputSchema: connectionOutput,
    annotations: { ...changes, readOnlyHint: true, idempotentHint: true },
    _meta: widgetMeta,
  }, async () => connectionResult(state));
  server.registerTool(
    "connect",
    {
      description: "Reuse this computer's GrantTap pairing, or create a one-time QR when none exists.",
      inputSchema: {},
      outputSchema: connectionOutput,
      annotations: changes,
      _meta: widgetMeta,
    },
    async (): Promise<CallToolResult> => perform(),
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
      ? perform(true)
      : ({ isError: true, content: [{ type: "text", text: "Reconnect cancelled: explicit confirmation is required." }] }),
  );
}

async function connect(state: ConnectionState, replace = false): Promise<CallToolResult> {
  try {
    if (!replace && isMachineConfigured()) return connectionResult(state, true);
    const startedAt = Date.now();
    const pairing = await createOneTimePairing(process.env.GRANTTAP_TEST_RELAY_URL ?? DEFAULT_RELAY);
    const png = await QRCode.toBuffer(pairing.qrPayload, {
      type: "png", width: 900, margin: 4, errorCorrectionLevel: "L",
    });
    state.remember({
      room: pairing.machineCfg.room,
      expiresAt: startedAt + PAIRING_CODE_TTL_MINUTES * 60_000,
      pairingUri: pairing.qrPayload,
      qrDataUrl: `data:image/png;base64,${png.toString("base64")}`,
    });
    resetRelay();
    void relay();
    return connectionResult(state, true);
  } catch {
    return {
      isError: true,
      content: [{ type: "text", text: "GrantTap could not create the pairing code. Check the relay and try again. Your existing pairing is retained if the relay rejects the request." }],
    };
  }
}

function connectionResult(state: ConnectionState, showQr = false): CallToolResult {
  const snapshot = state.snapshot();
  const { status, computer, relay, version, relayStatus } = snapshot.structuredContent;
  const instructions = status === "pairing"
    ? "Scan the one-time QR in GrantTap on iPhone → Settings → Connections, or copy the link from the connection card."
    : status === "disconnected" ? "Choose Connect to create a one-time QR. No account or password is required."
    : status === "expired" ? "The QR has expired. Reconnect with confirmation to replace the pairing and generate a new code."
    : "Existing secure pairing reused. A saved pairing does not prove that the iPhone is online. Reconnect replaces it only with confirmation.";
  const content: CallToolResult["content"] = [{ type: "text", text:
    `GrantTap: ${status}. Computer: ${computer}. MCP ${version}. Relay: ${relay || "not configured"} (${relayStatus}).\n${instructions}`,
  }];
  const qr = snapshot._meta.granttap.qrDataUrl;
  if (showQr && qr) content.push({
    type: "image", data: qr.slice("data:image/png;base64,".length), mimeType: "image/png",
    annotations: { audience: ["user"] },
  });
  return { ...snapshot, content };
}
