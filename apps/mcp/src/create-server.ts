/** Shared GrantTap MCP tool registration for stdio and HTTP transports. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerConnectTool } from "./mcp-tools/connect";
import { registerInteractionTools } from "./mcp-tools/interaction";
import { registerMeshResource } from "./mcp-tools/mesh-resource";

export { askOpenQuestion, askYesNo, relay, resetRelay } from "./mcp-tools/relay";

export function createGrantTapServer(): McpServer {
  const server = new McpServer({
    name: "granttap",
    title: "GrantTap",
    version: "0.7.2",
    websiteUrl: "https://granttap.com",
    icons: [{ src: "https://granttap.com/favicon.png", mimeType: "image/png", sizes: ["64x64"] }],
  });
  registerConnectTool(server);
  registerInteractionTools(server);
  registerMeshResource(server);
  return server;
}
