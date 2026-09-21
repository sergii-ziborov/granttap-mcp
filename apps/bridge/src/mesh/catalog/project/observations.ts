import type {
  ProjectCapabilityObservation, ProjectCapabilityRequest, ProjectMcpServer, SharedSkill,
} from "../../../../../../packages/protocol/schema";

type Input = {
  projectId: string;
  endpointId: string;
  bound: boolean;
  requests: ProjectCapabilityRequest[];
  skills: SharedSkill[];
  mcpServers: ProjectMcpServer[];
  now: number;
};

/** A host reports what it can verify locally; no request becomes an install. */
export function projectCapabilityObservations(input: Input): ProjectCapabilityObservation[] {
  return input.requests.flatMap((request) => {
    if (!request.requestId || request.projectId !== input.projectId
      || request.targetEndpointId && request.targetEndpointId !== input.endpointId) return [];
    const found = request.kind === "skill"
      ? skillObservation(request, input.skills, input.endpointId)
      : mcpObservation(request, input.mcpServers, input.endpointId);
    return [{
      projectId: input.projectId, requestId: request.requestId,
      endpointId: input.endpointId,
      state: input.bound ? found.state : "needs_binding" as const,
      version: found.version, artifactDigest: found.artifactDigest,
      observedAt: input.now,
    }];
  }).slice(0, 128);
}

function skillObservation(
  request: ProjectCapabilityRequest, skills: SharedSkill[], endpointId: string,
): Pick<ProjectCapabilityObservation, "state" | "version" | "artifactDigest"> {
  const found = skills.find((skill) =>
    skill.name.toLowerCase() === request.name.toLowerCase()
      && skill.endpointId === endpointId);
  if (!found) return { state: "not_found" };
  if (found.state === "conflict") return { state: "version_conflict" };
  if (!found.digest) return { state: "unsupported", version: found.version };
  if (request.artifactDigest && request.artifactDigest !== found.digest
    || request.version && found.version && request.version !== found.version) {
    return { state: "version_conflict", version: found.version, artifactDigest: found.digest };
  }
  return { state: "discovered", version: found.version, artifactDigest: found.digest };
}

function mcpObservation(
  request: ProjectCapabilityRequest, servers: ProjectMcpServer[], endpointId: string,
): Pick<ProjectCapabilityObservation, "state" | "version" | "artifactDigest"> {
  const candidates = servers.filter((server) =>
    server.name.toLowerCase() === request.name.toLowerCase()
      && server.endpointId === endpointId);
  if (candidates.length === 0) return { state: "not_found" };
  const found = request.artifactDigest
    ? candidates.filter((server) => server.configDigest === request.artifactDigest)
    : candidates;
  if (found.length === 0) {
    return { state: candidates.every((server) => !server.configDigest)
      ? "unsupported" : "version_conflict" };
  }
  if (found.some((server) => server.authStatus === "conflict")
    || new Set(found.map((server) => server.version).filter(Boolean)).size > 1) {
    return { state: "version_conflict" };
  }
  const version = found.every((server) => server.version === found[0]?.version)
    ? found[0]?.version : undefined;
  if (request.version && found.some((server) => server.version !== request.version)) {
    return { state: "version_conflict", version };
  }
  if (found.some((server) => !server.configuredEnabled || !server.allowed)) {
    return { state: "unsupported", version };
  }
  if (found.some((server) => ["not_authenticated", "unauthorized", "credential_missing"]
    .includes(server.authStatus ?? ""))) {
    return { state: "credential_missing", version };
  }
  return {
    state: found.every((server) => server.metadataSource === "mcp") ? "initialized" : "configured",
    version,
  };
}
