import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";

/** The version in the name makes hosts that cache a card by its URI load the new one. */
export const CONNECTION_WIDGET_URI = "ui://granttap/connection/v6.html";

/** The card's scripts, in the order they share one module: helpers first, view.js last starts it. */
export const CARD_SCRIPTS = ["bridge.js", "phones.js", "phones-view.js", "view.js"] as const;

export const cardAsset = (name: string) =>
  readFileSync(new URL(`../../connection-center/card/${name}`, import.meta.url), "utf8");

/** The self-contained card: its style and scripts inlined, so the host loads nothing else. */
export function connectionCardHtml(): string {
  // A function replacement, so "$&" or "$'" in a script are never read as patterns.
  return cardAsset("widget.html").replace("{{STYLE}}", () => cardAsset("card.css"))
    .replace("{{SCRIPT}}", () => CARD_SCRIPTS.map(cardAsset).join("\n"));
}

const html = connectionCardHtml();

export function registerConnectionWidget(server: McpServer): void {
  server.registerResource(
    "granttap-connection",
    CONNECTION_WIDGET_URI,
    {
      title: "GrantTap connection center",
      description: "GrantTap card: phones paired with this computer and their removal, QR device pairing, Mac account "
        + "passkey linking, automatic updates, and connection status.",
      mimeType: "text/html;profile=mcp-app",
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: "text/html;profile=mcp-app",
        text: html,
        _meta: {
          ui: { prefersBorder: true, permissions: { clipboardWrite: {} }, csp: { connectDomains: [], resourceDomains: [] } },
          "openai/widgetDescription": "Manage the phones paired with this computer, pair a device by QR, or link this Mac to your account with passkey.",
          "openai/widgetPrefersBorder": true,
        },
      }],
    }),
  );
}
