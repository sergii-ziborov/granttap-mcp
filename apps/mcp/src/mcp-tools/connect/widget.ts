import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const CONNECTION_WIDGET_URI = "ui://granttap/connection/v3.html";

import { readFileSync } from "node:fs";

const asset = (name: string) => readFileSync(new URL(`../../connection-center/${name}`, import.meta.url), "utf8");
const html = asset("widget.html").replace("{{SCRIPT}}", asset("bridge.js") + "\n" + asset("view.js"));

export function registerConnectionWidget(server: McpServer): void {
  server.registerResource(
    "granttap-connection",
    CONNECTION_WIDGET_URI,
    {
      title: "GrantTap connection center",
      description: "GrantTap card: devices in this pairing room, Add a device, and the QR on this card only.",
      mimeType: "text/html;profile=mcp-app",
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: "text/html;profile=mcp-app",
        text: html,
        _meta: {
          ui: { prefersBorder: true, permissions: { clipboardWrite: {} }, csp: { connectDomains: [], resourceDomains: [] } },
          "openai/widgetDescription": "List devices in this pairing room and add one with a QR that stays on this card.",
          "openai/widgetPrefersBorder": true,
        },
      }],
    }),
  );
}
