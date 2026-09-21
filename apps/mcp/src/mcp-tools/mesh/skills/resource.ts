import { lstatSync, readFileSync } from "node:fs";
import { skillBundleDigest } from "../../../../../bridge/src/capabilities/skill-bundle";
import { skillDefinitionPath } from "../../../../../bridge/src/capabilities/skills";
import { isMeshEnabled } from "../../../../../bridge/src/config/runtime";
import { computerId } from "../../../../../bridge/src/mesh/identity/computer";
import {
  liveExecutionScope, resolveExecutionCapability,
} from "../../../../../bridge/src/mesh/catalog/capability";
import { localMeshStore } from "../../../../../bridge/src/mesh/local-remote/local";
import { json } from "../current";

const MAX_SKILL_BYTES = 64 * 1024;

/** Read a Project bundle's SKILL.md through the same execution scope as Mesh. */
export function readScopedSkill(
  uri: URL, capability: string | string[], requestedName: string | string[],
) {
  const token = Array.isArray(capability) ? capability[0] : capability;
  const name = Array.isArray(requestedName) ? requestedName[0] : requestedName;
  if (!isMeshEnabled() || !name || name.length > 160 || /[\/\u0000-\u001f]/.test(name)) {
    return unavailable(uri);
  }
  const resolved = resolveExecutionCapability(token);
  const scope = resolved ? liveExecutionScope(resolved.sessionId) : undefined;
  if (!resolved || !scope || scope.execution.taskId !== resolved.taskId
    || scope.snapshot.projectId !== resolved.projectId
    || scope.execution.computerId !== computerId()) return unavailable(uri);
  const definition = skillDefinitionPath(name, scope.execution.workspace);
  if (!definition) return unavailable(uri);
  const digest = skillBundleDigest(definition);
  const snapshot = localMeshStore().snapshot(resolved.projectId, computerId());
  const shared = snapshot?.skills?.find((skill) =>
    skill.name === name && skill.endpointId === computerId()
      && skill.state === "discovered" && skill.digest === digest);
  if (!shared || !digest) return unavailable(uri);
  try {
    const stat = lstatSync(definition);
    if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) return unavailable(uri);
    const body = readFileSync(definition, "utf8");
    if (skillBundleDigest(definition) !== digest) return unavailable(uri);
    return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: body }] };
  } catch {
    return unavailable(uri);
  }
}

function unavailable(uri: URL) {
  return json(uri.href, {
    schema: "granttap.mesh-skill.v1", available: false,
    reason: "No permitted matching Project skill bundle is available for this execution.",
  });
}
