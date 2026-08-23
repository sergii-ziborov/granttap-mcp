import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGrokBotMeshTools } from "./mcp-tools/mesh-tools";

export function createGrokBotMeshServer(): McpServer {
  const server = new McpServer({
    name: "granttap-project-mesh",
    title: "GrantTap Project Mesh for Grok Bot",
    version: "0.7.0",
    websiteUrl: "https://granttap.com",
  });
  registerGrokBotMeshTools(server);
  return server;
}
