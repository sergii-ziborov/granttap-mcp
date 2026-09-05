import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  executionCapabilityFor,
  liveExecutionScope,
  resolveExecutionCapability,
} from "../../../bridge/src/mesh/capability";
import { scopedMeshView } from "../../../bridge/src/mesh/scoped-view";
import { meshMap } from "../../../bridge/src/mesh/map";
import { isMeshEnabled } from "../../../bridge/src/config/runtime";

const MESH_URI = "granttap://mesh/current";
export const MAP_URI = "granttap://mesh/map";
const SCOPE_HINT =
  "Project Mesh reads are scoped to one execution. In Claude Code, read "
  + `${MAP_URI}. Elsewhere, call notify to receive this session's `
  + "granttap://mesh/<capability> URI, then read that URI.";

/**
 * The chat this server belongs to.
 *
 * Claude Code starts one MCP server per chat and hands it the chat's id in
 * the environment. Nothing said over the connection can change that, which
 * makes it the one identity a resource read — which no hook attributes — can
 * trust. Other providers set nothing here and keep using minted capabilities.
 */
export function sessionFromEnvironment(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const id = env.CLAUDE_CODE_SESSION_ID?.trim() ?? "";
  return /^[A-Za-z0-9._-]{8,128}$/.test(id) ? id : undefined;
}

/** This chat's Project as a page of markdown, or how to get one. */
function mapFor(sessionId: string | undefined): string {
  const scope = isMeshEnabled() && sessionId ? liveExecutionScope(sessionId) : undefined;
  return scope ? meshMap(scope.snapshot) : `# Project Mesh\n\n${SCOPE_HINT}\n`;
}

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
    async (uri) => {
      // A server that knows its chat serves that chat's own scope here.
      const sessionId = sessionFromEnvironment();
      const capability = isMeshEnabled() && sessionId ? executionCapabilityFor(sessionId) : undefined;
      const view = capability ? scopedMeshView(capability) : undefined;
      if (view) return json(uri.href, { ...view, enabled: true, scoped: true });
      return json(uri.href, {
        schema: "granttap.mesh-scope-hint.v1",
        enabled: isMeshEnabled(),
        scoped: false,
        hint: SCOPE_HINT,
      });
    },
  );

  // Listed, so a client that only reads listed resources — Claude Code's
  // does — can open it straight from the prompt hook's one line.
  server.registerResource(
    "project-mesh-map",
    MAP_URI,
    {
      title: "GrantTap Project Mesh map",
      description: "This chat's Project as a readable map: Tasks, who edits what, the other side of each "
        + "repository, what just happened. Transcripts are never included.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: mapFor(sessionFromEnvironment()) }],
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

  // The same Project as one page of markdown: Tasks, who edits which module,
  // the other side of each repository, dependencies, and what just happened.
  server.registerResource(
    "project-mesh-map-scoped",
    new ResourceTemplate("granttap://mesh/{capability}/map", { list: undefined }),
    {
      title: "GrantTap Project Mesh map (scoped)",
      description: "This execution's Project as a readable map. Transcripts are never included.",
      mimeType: "text/markdown",
    },
    async (uri, { capability }) => {
      const token = Array.isArray(capability) ? capability[0] : capability;
      const resolved = isMeshEnabled() ? resolveExecutionCapability(token) : undefined;
      const scope = resolved ? liveExecutionScope(resolved.sessionId) : undefined;
      const text = scope && scope.snapshot.projectId === resolved?.projectId
        ? meshMap(scope.snapshot)
        : mapFor(undefined);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
    },
  );
}
