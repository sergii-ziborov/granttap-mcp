import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGrokBotMeshServer } from "./mesh-server";

const server = createGrokBotMeshServer();
await server.connect(new StdioServerTransport());
