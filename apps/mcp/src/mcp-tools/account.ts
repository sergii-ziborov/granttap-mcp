import QRCode from "qrcode";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { completeLogin, startLogin } from "../../../bridge/src/account-linking/client";
import { protectedVault } from "../../../bridge/src/account-linking/keychain";
import { AccountStore } from "../../../bridge/src/account-linking/store";
import { configDir } from "../../../bridge/src/config";

function store(): AccountStore { return new AccountStore(configDir(), protectedVault()); }

function statusText(value: AccountStore): string {
  const status = value.status();
  if (status.kind === "signed_out") return "GrantTap account: signed out. Personal/Team login is optional.";
  if (status.kind === "pending") return "GrantTap account: waiting for one-time QR confirmation.";
  const organization = status.account.organizationId ? `, organization ${status.account.organizationId}` : "";
  return `GrantTap account: ${status.kind === "expired" ? "expired" : "signed in"}, ${status.account.mode}${organization}, device ${status.account.deviceId}.`;
}

async function loginResult(input: {
  action: "start" | "complete"; mode: "personal" | "enterprise";
  organization?: string; controlUrl?: string; relogin?: boolean;
}): Promise<CallToolResult> {
  try {
    const account = store();
    if (input.action === "complete") {
      const result = await completeLogin(account);
      return { content: [{ type: "text", text: result === "authorized"
        ? statusText(account) : "GrantTap login is still waiting for QR confirmation." }] };
    }
    if (!input.relogin && account.status().kind === "signed_in") {
      return { content: [{ type: "text", text: `${statusText(account)} Use relogin only when the user asks.` }] };
    }
    const authorization = await startLogin(account, {
      controlUrl: input.controlUrl ?? process.env.GRANTTAP_CONTROL_URL ?? "https://control.granttap.com",
      mode: input.mode, ...(input.organization ? { organization: input.organization } : {}),
    });
    const png = await QRCode.toBuffer(authorization.verificationUriComplete, {
      type: "png", width: 900, margin: 4, errorCorrectionLevel: "M",
    });
    return { content: [
      { type: "text", text: [
        `GrantTap ${authorization.mode} login`, `Open: ${authorization.verificationUri}`,
        `One-time code: ${authorization.userCode}`,
        "The QR contains no device code, token, pairing key, or provider credential.",
        "After approval, call login again with action=complete.",
      ].join("\n"), annotations: { audience: ["user"] } },
      { type: "image", data: png.toString("base64"), mimeType: "image/png",
        annotations: { audience: ["user"] } },
    ] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text:
      `GrantTap login failed: ${error instanceof Error ? error.message : String(error)}` }] };
  }
}

export function registerAccountTools(server: McpServer): void {
  server.tool("login", "Start or complete protected GrantTap account login. Personal/Team is optional; Enterprise is required. This never replaces phone pairing.", {
    action: z.enum(["start", "complete"]).default("start"),
    mode: z.enum(["personal", "enterprise"]).default("personal"),
    organization: z.string().min(1).max(255).optional(),
    controlUrl: z.string().url().max(2_048).optional(),
    relogin: z.boolean().optional().describe("Start a fresh login without replacing phone pairing."),
  }, loginResult);
  server.tool("account_status", "Read GrantTap account state without returning account tokens or pairing keys.", {}, async () => {
    try { return { content: [{ type: "text", text: statusText(store()) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text", text:
      `GrantTap account status failed: ${error instanceof Error ? error.message : String(error)}` }] }; }
  });
  server.tool("logout", "Remove the GrantTap account session and Enterprise login receipt without changing phone pairing or provider logins.", {}, async () => {
    try { const account = store(); account.logout(); return { content: [{ type: "text", text:
      "GrantTap account: signed out. Phone pairing and provider logins were not changed." }] }; }
    catch (error) { return { isError: true, content: [{ type: "text", text:
      `GrantTap logout failed: ${error instanceof Error ? error.message : String(error)}` }] }; }
  });
}
