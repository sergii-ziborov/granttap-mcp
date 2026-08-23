import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { localMeshStore } from "../../../bridge/src/mesh/local";
import { isMeshEnabled } from "../../../bridge/src/config/runtime";

const MESH_URI = "granttap://mesh/current";

/** Read-only compact coordination state; transcript and hidden reasoning never enter it. */
export function registerMeshResource(server: McpServer): void {
  server.registerResource(
    "project-mesh",
    MESH_URI,
    {
      title: "GrantTap Project Mesh",
      description: "Active project tasks, execution owners, dependencies, claims, and relevant structured events.",
      mimeType: "application/json",
    },
    async (uri) => {
      const store = localMeshStore();
      const projects = isMeshEnabled()
        ? store.projectIds().flatMap((projectId) => store.snapshot(projectId) ?? [])
        : [];
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ enabled: isMeshEnabled(), generatedAt: Date.now(), projects }),
        }],
      };
    },
  );
}
