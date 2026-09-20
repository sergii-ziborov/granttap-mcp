/** Shared GrantTap MCP tool registration for stdio and HTTP transports. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerConnectTool } from "../mcp-tools/connect";
import { registerConnectionWidget } from "../mcp-tools/connect/widget";
import { registerInteractionTools } from "../mcp-tools/interaction";
import { registerMeshResource } from "../mcp-tools/mesh/resource";
import { packageVersion } from "../status/package-version";

export { askOpenQuestion, askYesNo, relay, resetRelay } from "../mcp-tools/connect/relay";

export function createGrantTapServer(): McpServer {
  const server = new McpServer({
    name: "granttap",
    title: "GrantTap",
    version: packageVersion(),
    websiteUrl: "https://granttap.com/connect",
    icons: [{ src: "https://granttap.com/favicon.png", mimeType: "image/png", sizes: ["64x64"] }],
  });
  registerConnectTool(server);
  registerInteractionTools(server);
  registerMeshResource(server);
  registerConnectionWidget(server);
  return server;
}
