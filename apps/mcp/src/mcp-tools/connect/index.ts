import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ConnectionState, connectionOutput } from "../../connection-center/state";
import { CONNECTION_WIDGET_URI } from "./widget";
import { registerRuntimeUpdateControl } from "../../connection-center/update-controls";
import { callingChat } from "../../status/chat-status";
import { connect, connectionResult, signIn, type ConnectOptions } from "./account-first";

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

const SIGN_IN = "Sign this computer in to the person's GrantTap account with their passkey: the one sign-in a computer "
  + "needs. Use it when connection_status shows accountLink.state none or revoked, or a tool says this computer is "
  + "signed out. Returns passkeyUrl, a granttap.com page for one use within 15 minutes (also on the connection card), "
  + "where the person confirms with their GrantTap passkey; the passkey is entered only there. Once signed in, a phone "
  + "signed in to the same account links this computer by itself, without a QR. Existing QR pairings are unchanged. "
  + "Not for signing in to other services on the phone: that is request_sign_in.";

export function registerConnectTool(server: McpServer): void {
  const state = new ConnectionState();
  registerRuntimeUpdateControl(server, () => connectionResult(state), widgetMeta);
  let pendingCall: Promise<CallToolResult> | null = null;
  const perform = (options: ConnectOptions = {}) => {
    if (pendingCall) return pendingCall;
    pendingCall = connect(state, options).finally(() => { pendingCall = null; });
    return pendingCall;
  };
  server.registerTool("connection_status", {
    title: "GrantTap connection center",
    description: "Read GrantTap's state on this computer without changing it: whether it is signed in to the person's "
      + "GrantTap account (accountLink: ok, none, revoked, not covered by the subscription, or unreachable), the pairing "
      + "and every paired phone with its id and when it last reached this computer (pass ids of unused ones to "
      + "remove_phones), any open pairing QR, relay reachability, provider readiness, the runtime version and any newer "
      + "one waiting to take over and what it waits for, and, for the calling chat (Claude Code, Codex, Grok Build, "
      + "Cursor), how many phone messages are queued to reach it after this turn and whether it continues by itself "
      + "after a subscription limit. Shows the connection card where the host renders one. Use it to diagnose sign-in, "
      + "pairing or phone delivery, and before long repository-wide work. Never creates, replaces or removes a pairing.",
    inputSchema: {},
    outputSchema: connectionOutput,
    annotations: { ...changes, readOnlyHint: true, idempotentHint: true },
    _meta: widgetMeta,
  }, async (args) => connectionResult(state, callingChat("connection_status", args ?? {})));
  server.registerTool("sign_in", {
    title: "Sign this computer in to GrantTap",
    description: SIGN_IN,
    inputSchema: {},
    outputSchema: connectionOutput,
    annotations: changes,
    _meta: widgetMeta,
  }, async () => signIn(state));
  server.registerTool("connect_with_passkey", {
    title: "Sign this computer in to GrantTap (deprecated name)",
    description: "Deprecated alias of sign_in, kept for one release; use sign_in. Same behavior: returns passkeyUrl, "
      + "a granttap.com passkey page that signs this computer in to the person's GrantTap account.",
    inputSchema: {},
    outputSchema: connectionOutput,
    annotations: changes,
    _meta: widgetMeta,
  }, async () => signIn(state));
  server.registerTool(
    "connect",
    {
      description: "Connect this computer to the GrantTap phone app, account first. Not signed in (or signed out): "
        + "returns passkeyUrl to sign it in as the first step, and on an unpaired computer also a one-time pairing QR "
        + "on the connection card (never in chat) as the fallback. Signed in but no phone yet: creates nothing and says "
        + "to open GrantTap on an iPhone signed in to the same account, which links this computer by itself. Paired: "
        + "shows the card with the saved pairing and starts the relay link. Returns the same state as "
        + "connection_status. For a QR to restore a phone or add another device, use reconnect.",
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
      description: "The QR fallback, after the person confirms: show a new one-time pairing QR, valid 15 minutes, on "
        + "the connection card, for a phone that cannot link through the GrantTap account. mode=reconnect offers this "
        + "computer's existing phone pairing again, for a phone that lost it; mode=add_device enrolls one more phone or "
        + "iPad with its own key (at most 16 added keys; at the limit the added phone longest unseen, if unseen for 24 "
        + "hours, gives its place; one never scanned is dropped). The current room and paired phones keep working. Pass "
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
