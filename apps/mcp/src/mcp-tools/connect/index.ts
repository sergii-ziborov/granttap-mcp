import QRCode from "qrcode";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createOneTimePairing, DEFAULT_RELAY, PAIRING_CODE_TTL_MINUTES } from "../../../../bridge/src/pairing";
import { isMachineConfigured } from "../../status/pairing-status";
import { ConnectionState, connectionOutput } from "../../connection-center/state";
import { CONNECTION_WIDGET_URI } from "./widget";
import { resetRelay, relay } from "./relay";
import { startPasskeyAccountLink } from "../../connection-center/passkey";
import { registerRuntimeUpdateControl } from "../../connection-center/update-controls";
import { callingChat, chatStatusLine, type CallingChat } from "../../status/chat-status";
import { phoneSummary } from "../../status/pairing-status";

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
  registerRuntimeUpdateControl(server, () => connectionResult(state), widgetMeta);
  let pendingCall: Promise<CallToolResult> | null = null;
  const perform = (options: { issue?: boolean; replace?: boolean; addController?: boolean } = {}) => {
    if (pendingCall) return pendingCall;
    pendingCall = connect(state, options).finally(() => { pendingCall = null; });
    return pendingCall;
  };
  server.registerTool("connection_status", {
    title: "GrantTap connection center",
    description: "Read GrantTap's state on this computer without changing it: the pairing and paired phones with when each "
      + "last reached this computer, any open pairing QR, relay reachability, provider readiness, the runtime version and any "
      + "newer one waiting to take over and what it waits for, and, for the calling chat (Claude Code, Codex, Grok Build, "
      + "Cursor), how many phone messages are queued to reach it after this turn and whether it continues by itself after "
      + "a subscription limit. Shows the connection card where "
      + "the host renders one. Use it to diagnose pairing or phone delivery, and before long repository-wide work. Never "
      + "creates, replaces or removes a pairing.",
    inputSchema: {},
    outputSchema: connectionOutput,
    annotations: { ...changes, readOnlyHint: true, idempotentHint: true },
    _meta: widgetMeta,
  }, async (args) => connectionResult(state, callingChat("connection_status", args ?? {})));
  server.registerTool("connect_with_passkey", {
    title: "Link this Mac to a GrantTap account",
    description: "Link this Mac to the person's GrantTap account, so a phone signed in to that account can connect to it "
      + "without a QR. Returns passkeyUrl, a granttap.com page valid for 15 minutes (also on the connection card), where the "
      + "person confirms with their account passkey; the passkey is entered only there. Existing QR pairings are unchanged.",
    inputSchema: {},
    outputSchema: connectionOutput,
    annotations: changes,
    _meta: widgetMeta,
  }, async () => {
    try {
      const passkeyUrl = await startPasskeyAccountLink();
      const result = connectionResult(state);
      const meta = result._meta?.granttap;
      const granttap = meta && typeof meta === "object" ? meta : {};
      return { ...result,
        structuredContent: { ...result.structuredContent, passkeyUrl },
        _meta: { granttap: { ...granttap, passkeyUrl } } };
    } catch {
      return { isError: true, content: [{ type: "text", text: "GrantTap could not start passkey linking. Check the account service and try again." }] };
    }
  });
  server.registerTool(
    "connect",
    {
      description: "Pair this computer with the GrantTap phone app. On a computer that is not paired yet, creates a one-time "
        + "pairing QR, valid 15 minutes, shown on the connection card and never in chat; on a paired computer, only shows the "
        + "card with the saved pairing and starts the relay link. Returns the same state as connection_status. To pair a "
        + "phone again or add another device, use reconnect.",
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
      description: "After the person confirms, show a new one-time pairing QR, valid 15 minutes, on the connection card. "
        + "mode=reconnect offers this computer's existing phone pairing again, for a phone that lost it; mode=add_device "
        + "enrolls one more phone or iPad with its own key (at most 16 added keys; a scanned key stays paired until the "
        + "pairing is replaced, one never scanned is dropped). The current room and paired phones keep working. Pass "
        + "confirmed=true only after the person agreed.",
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

function connectionResult(state: ConnectionState, caller?: CallingChat): CallToolResult {
  const snapshot = caller ? state.snapshot(Date.now(), caller) : state.snapshot();
  const { status, computer, relay, version, relayStatus, runtimeUpdates, phones, pendingUpdate, chat } = snapshot.structuredContent;
  const instructions = status === "pairing"
    ? "Use the GrantTap card: tap Add a device if needed, then scan the QR on the card."
    : status === "disconnected" ? "Use the GrantTap card and tap Add a device. The QR stays on the card."
    : status === "expired" ? "The card QR expired. Tap Add a device again and confirm."
    : "The GrantTap card shows the saved pairing room on this Mac and last confirmed activity. Add another device to start a new enrollment attempt. A Mesh link shares Mesh only.";
  const details = [
    phoneSummary(phones),
    pendingUpdate ? `Runtime ${pendingUpdate.version} is waiting: ${pendingUpdate.detail}` : undefined,
    chatStatusLine(chat),
  ].filter(Boolean).join("\n");
  return {
    ...snapshot,
    content: [{ type: "text", text:
      `GrantTap: ${status}. Computer: ${computer}. MCP ${version}. Relay: ${relay || "not configured"} (${relayStatus}). Automatic runtime updates: ${runtimeUpdates.enabled ? "on" : "off"}.\n${details ? `${details}\n` : ""}${instructions}`,
    }],
  };
}
