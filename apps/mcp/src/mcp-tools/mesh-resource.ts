import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveExecutionCapability } from "../../../bridge/src/mesh/capability";
import { scopedMeshView } from "../../../bridge/src/mesh/scoped-view";
import { isMeshEnabled } from "../../../bridge/src/config/runtime";

const MESH_URI = "granttap://mesh/current";
const SCOPE_HINT =
  "Project Mesh reads are scoped to one execution. Call notify to receive this "
  + "session's granttap://mesh/<capability> URI, then read that URI.";

function json(uri: string, value: unknown) {
  return {
    contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value) }],
  };
}

/**
 * Read-only compact coordination state.
 *
 * The unscoped URI deliberately carries no Project data: a model that read it
 * would learn Task titles, repositories, branches and session ids belonging to
 * every other Project on this computer, which is exactly the identity material
 * an injected prompt needs. Real state is served only against the capability
 * minted for the calling execution.
 */
export function registerMeshResource(server: McpServer): void {
  server.registerResource(
    "project-mesh",
    MESH_URI,
    {
      title: "GrantTap Project Mesh",
      description: "How to obtain this execution's scoped coordination state.",
      mimeType: "application/json",
    },
    async (uri) => json(uri.href, {
      schema: "granttap.mesh-scope-hint.v1",
      enabled: isMeshEnabled(),
      scoped: false,
      hint: SCOPE_HINT,
    }),
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
    async (uri, { capability }) => {
      if (!isMeshEnabled()) {
        return json(uri.href, { schema: "granttap.mesh-scope.v1", enabled: false, scoped: false });
      }
      const token = Array.isArray(capability) ? capability[0] : capability;
      const resolved = token === "current" ? undefined : resolveExecutionCapability(token);
      const view = resolved ? scopedMeshView(resolved) : undefined;
      if (!view) return json(uri.href, { schema: "granttap.mesh-scope.v1", enabled: true, scoped: false, hint: SCOPE_HINT });
      return json(uri.href, { ...view, enabled: true, scoped: true });
    },
  );
}
