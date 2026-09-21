import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  currentMapContents,
  MESH_URI,
  readCurrentMesh,
  readScopedMap,
  readScopedMesh,
} from "./current";
import { readScopedSkill } from "./skills/resource";

export { sessionFromEnvironment, sessionBindingFromEnvironment } from "./session-env";
export const MAP_URI = "granttap://mesh/map";

export function registerMeshResource(server: McpServer): void {
  server.registerResource(
    "project-mesh",
    MESH_URI,
    {
      title: "GrantTap Project Mesh",
      description: "How to obtain this execution's scoped coordination state.",
      mimeType: "application/json",
    },
    async (uri) => readCurrentMesh(uri),
  );
  server.registerResource(
    "project-mesh-map",
    MAP_URI,
    {
      title: "GrantTap Project Mesh map",
      description: "This chat's Project as a readable map: Tasks, who edits what, the other side of each "
        + "repository, what just happened. Transcripts are never included.",
      mimeType: "text/markdown",
    },
    async (uri) => currentMapContents(uri),
  );
  server.registerResource(
    "project-mesh-scope",
    new ResourceTemplate("granttap://mesh/{capability}", { list: undefined }),
    {
      title: "GrantTap Project Mesh (scoped)",
      description:
        "This execution's Project, Task, owners, dependencies, claims, and relevant events. "
        + "Transcripts and hidden reasoning are never included.",
      mimeType: "application/json",
    },
    async (uri, { capability }) => readScopedMesh(uri, capability ?? ""),
  );
  server.registerResource(
    "project-mesh-map-scoped",
    new ResourceTemplate("granttap://mesh/{capability}/map", { list: undefined }),
    {
      title: "GrantTap Project Mesh map (scoped)",
      description: "This execution's Project as a readable map. Transcripts are never included.",
      mimeType: "text/markdown",
    },
    async (uri, { capability }) => readScopedMap(uri, capability ?? ""),
  );
  server.registerResource(
    "project-skill-bundle-scoped",
    new ResourceTemplate("granttap://mesh/{capability}/skills/{skill}", { list: undefined }),
    {
      title: "GrantTap Project Skill (scoped)",
      description: "This execution's verified Project SKILL.md; reading does not authorize tools or scripts.",
      mimeType: "text/markdown",
    },
    async (uri, { capability, skill }) => readScopedSkill(uri, capability ?? "", skill ?? ""),
  );
}
