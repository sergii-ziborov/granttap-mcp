import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGrokBotMeshServer } from "./mesh-server";

const server = createGrokBotMeshServer();
const transport = new StdioServerTransport();
transport.onclose = () => process.exit(0);
process.stdin.once("end", () => process.exit(0));
await server.connect(transport);
