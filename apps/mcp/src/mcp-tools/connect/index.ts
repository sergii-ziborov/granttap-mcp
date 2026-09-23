import QRCode from "qrcode";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createOneTimePairing, DEFAULT_RELAY, PAIRING_CODE_TTL_MINUTES } from "../../../../bridge/src/pairing";
import { isMachineConfigured } from "../../status/pairing-status";
import { ConnectionState, connectionOutput } from "../../connection-center/state";
import { CONNECTION_WIDGET_URI } from "./widget";
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
  const perform = (options: { issue?: boolean; replace?: boolean; addController?: boolean } = {}) => {
    if (pendingCall) return pendingCall;
    pendingCall = connect(state, options).finally(() => { pendingCall = null; });
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
      description: "Open the GrantTap connection card: the saved pairing slot and Add a device. QR stays on the card, not in chat.",
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
      description: "Show a one-time QR for reconnect or add an independent controller device to this computer. Requires confirmation and keeps the current room.",
      inputSchema: {
        confirmed: z.boolean().describe("True only after the user confirms showing a new QR"),
        mode: z.enum(["reconnect", "add_device"]).default("reconnect"),
      },
      outputSchema: connectionOutput,
      annotations: { ...changes, destructiveHint: true },
      _meta: widgetMeta,
    },
    async ({ confirmed, mode }): Promise<CallToolResult> => confirmed
      ? perform({ issue: true, addController: mode === "add_device" })
      : ({ isError: true, content: [{ type: "text", text: "Reconnect cancelled: explicit confirmation is required." }] }),
  );
}

async function connect(
  state: ConnectionState,
  options: { issue?: boolean; replace?: boolean; addController?: boolean } = {},
): Promise<CallToolResult> {
  try {
    if (!options.issue && !options.replace && isMachineConfigured()) {
      void relay();
      return connectionResult(state);
    }
    const startedAt = Date.now();
    const pairing = await createOneTimePairing(process.env.GRANTTAP_TEST_RELAY_URL ?? DEFAULT_RELAY, {
      replace: options.replace === true,
      addController: options.addController === true,
    });
    const png = await QRCode.toBuffer(pairing.qrPayload, {
      type: "png", width: 900, margin: 4, errorCorrectionLevel: "L",
    });
    state.remember({
      room: pairing.machineCfg.room,
      expiresAt: startedAt + PAIRING_CODE_TTL_MINUTES * 60_000,
      pairingUri: pairing.qrPayload,
      qrDataUrl: `data:image/png;base64,${png.toString("base64")}`,
      peerPublicKey: pairing.phoneCfg.myPublicKey,
    });
    resetRelay();
    void relay();
    return connectionResult(state);
  } catch {
    return {
      isError: true,
      content: [{ type: "text", text: "GrantTap could not create the pairing code. Check the relay and try again. Your existing pairing is retained if the relay rejects the request." }],
    };
  }
}

function connectionResult(state: ConnectionState): CallToolResult {
  const snapshot = state.snapshot();
  const { status, computer, relay, version, relayStatus } = snapshot.structuredContent;
  const instructions = status === "pairing"
    ? "Use the GrantTap card: tap Add a device if needed, then scan the QR on the card."
    : status === "disconnected" ? "Use the GrantTap card and tap Add a device. The QR stays on the card."
    : status === "expired" ? "The card QR expired. Tap Add a device again and confirm."
    : "The GrantTap card shows the saved pairing room on this Mac and last confirmed activity. Add another device to start a new enrollment attempt. A Mesh link shares Mesh only.";
  return {
    ...snapshot,
    content: [{ type: "text", text:
      `GrantTap: ${status}. Computer: ${computer}. MCP ${version}. Relay: ${relay || "not configured"} (${relayStatus}).\n${instructions}`,
    }],
  };
}
