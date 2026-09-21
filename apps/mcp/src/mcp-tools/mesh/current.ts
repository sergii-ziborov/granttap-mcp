import {
  executionCapabilityFor,
  liveExecutionScope,
  resolveExecutionCapability,
} from "../../../../bridge/src/mesh/catalog/capability";
import { scopedMeshView } from "../../../../bridge/src/mesh/snapshot/scoped-view";
import { scopedInvocationSlice } from "../../../../bridge/src/engine/invocation/scope";
import { meshMap } from "../../../../bridge/src/mesh/snapshot/map";
import { isMeshEnabled } from "../../../../bridge/src/config/runtime";
import { parseProjectContextMode, renderProjectContext } from "../../../../bridge/src/mesh/context/project";
import { renderContextDelta } from "../../../../bridge/src/mesh/context/delta";
import { projectScopedSnapshot } from "../../../../bridge/src/mesh/snapshot/window";
import { sessionBindingFromEnvironment, sessionFromEnvironment } from "./session-env";

export const MESH_URI = "granttap://mesh/current";
export const SCOPE_HINT =
  "Project Mesh reads are scoped to one execution. In Claude Code, read "
  + "granttap://mesh/map. Elsewhere, call notify to receive this session's "
  + "granttap://mesh/<capability> URI, then read that URI.";

export function json(uri: string, value: unknown) {
  return {
    contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value) }],
  };
}

export async function readCurrentMesh(uri: URL) {
  const binding = sessionBindingFromEnvironment();
  const capability = isMeshEnabled() && binding.sessionId
    ? executionCapabilityFor(binding.sessionId)
    : undefined;
  const view = capability ? scopedMeshView(capability) : undefined;
  if (view) {
    const mode = parseProjectContextMode(uri.searchParams.get("mode") ?? undefined);
    const cursor = uri.searchParams.get("cursor") ?? undefined;
    const body = cursor
      ? renderContextDelta(view, { lastEventId: cursor })
      : await renderProjectContext(view, mode);
    return json(uri.href, {
      ...((body && typeof body === "object") ? body : {}),
      runtime: mode === "full" ? await scopedInvocationSlice(capability!) : undefined,
      enabled: true,
      scoped: true,
      identity: binding.identity,
    });
  }
  return json(uri.href, {
    schema: "granttap.mesh-scope-hint.v1",
    enabled: isMeshEnabled(),
    scoped: false,
    identity: binding.identity,
    hint: binding.identity === "unbound"
      ? `${SCOPE_HINT} This server has no current session identity; it will not guess one from the working directory.`
      : SCOPE_HINT,
  });
}

export function mapFor(sessionId: string | undefined): string {
  const scope = isMeshEnabled() && sessionId ? liveExecutionScope(sessionId) : undefined;
  return scope ? meshMap(scope.snapshot) : `# Project Mesh\n\n${SCOPE_HINT}\n`;
}

export async function readScopedMesh(uri: URL, capability: string | string[]) {
  if (!isMeshEnabled()) {
    return json(uri.href, { schema: "granttap.mesh-scope.v1", enabled: false, scoped: false });
  }
  const token = Array.isArray(capability) ? capability[0] : capability;
  const resolved = token === "current" ? undefined : resolveExecutionCapability(token);
  const view = resolved ? scopedMeshView(resolved) : undefined;
  if (!view) return json(uri.href, { schema: "granttap.mesh-scope.v1", enabled: true, scoped: false, hint: SCOPE_HINT });
  const mode = parseProjectContextMode(uri.searchParams.get("mode") ?? undefined);
  const cursor = uri.searchParams.get("cursor") ?? undefined;
  const body = cursor
    ? renderContextDelta(view, { lastEventId: cursor })
    : await renderProjectContext(view, mode);
  return json(uri.href, {
    ...(typeof body === "object" && body ? body : {}),
    runtime: mode === "full" ? await scopedInvocationSlice(resolved!) : undefined,
    enabled: true,
    scoped: true,
  });
}

export function readScopedMap(uri: URL, capability: string | string[]) {
  const token = Array.isArray(capability) ? capability[0] : capability;
  const resolved = isMeshEnabled() ? resolveExecutionCapability(token) : undefined;
  const scope = resolved ? liveExecutionScope(resolved.sessionId) : undefined;
  const permitted = scope && scope.snapshot.projectId === resolved?.projectId
    ? projectScopedSnapshot(scope.snapshot)
    : undefined;
  const text = permitted ? meshMap(permitted) : mapFor(undefined);
  return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
}

export function currentMapContents(uri: URL) {
  return {
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: mapFor(sessionFromEnvironment()) }],
  };
}
