/**
 * Add one of this computer's checkouts to a Project, or take one of its own
 * bindings out. Nothing here moves a repository between Projects or reaches
 * another computer's binding: what the person changes from the phone is what
 * this computer holds.
 */
import { isAbsolute } from "node:path";
import type {
  MeshRepositoryEdit,
  MeshRepositoryEditReason,
  Project,
  ProjectBindingSummary,
} from "../../../../../packages/protocol/schema";
import { queueProjectBindingSync } from "../../engine/runtime/engine-projects";
import { projectBindingIdentity, sanitizedRepositoryRemote } from "../identity";
import { readIntegrationMap } from "../observed/integration-map";
import type { MeshStore } from "../store";
import { checkoutName, readCheckout, type InspectRepository } from "./checkout";

export type RepositoryEditOutcome = {
  ok: boolean;
  reason?: MeshRepositoryEditReason;
  detail?: string;
  bindingId?: string;
  /** The binding that was added or removed, when the Mesh changed. */
  changed?: ProjectBindingSummary;
};

export function refusal(reason: MeshRepositoryEditReason, detail: string): RepositoryEditOutcome {
  return { ok: false, reason, detail };
}

const FAILED = "The Mesh could not be changed on this computer. Try again.";
const UNKNOWN_MESH = "This computer does not have this Mesh.";

export async function addMeshRepository(
  store: MeshStore, request: MeshRepositoryEdit, endpointId: string, inspect: InspectRepository,
): Promise<RepositoryEditOutcome> {
  if (!request.path || !isAbsolute(request.path)) {
    return refusal("invalid", "Adding a repository needs the full path of its checkout on this computer.");
  }
  const reading = await readCheckout(request.path, inspect);
  if (!reading.ok) {
    return reading.reason === "not-found"
      ? refusal("not-found", "There is no such folder on this computer.")
      : refusal("not-a-repository", "That folder is not inside a Git checkout.");
  }
  const { root, facts } = reading;
  const binding: ProjectBindingSummary = {
    bindingId: projectBindingIdentity(request.projectId, endpointId, facts.canonicalRepositoryId),
    projectId: request.projectId,
    endpointId,
    repositoryId: facts.canonicalRepositoryId,
    displayName: checkoutName(root),
    localPathHint: root,
    available: true,
    ...(facts.revision ? { revision: facts.revision } : {}),
  };
  const outcome = store.bindRepository(binding);
  switch (outcome.kind) {
    case "bound": {
      const project = store.project(request.projectId);
      if (project) admitBinding(store, project, outcome.binding, facts.baseRemote);
      return { ok: true, bindingId: outcome.binding.bindingId, changed: outcome.binding };
    }
    case "already-bound":
      return { ok: true, reason: "already-bound", bindingId: outcome.binding.bindingId,
        detail: "This repository is already in this Mesh on this computer." };
    case "bound-elsewhere": {
      const name = store.project(outcome.binding.projectId)?.name.slice(0, 160);
      return refusal("bound-elsewhere", name
        ? `This repository is in the Mesh "${name}" on this computer. Remove it there first.`
        : "This repository is in another Mesh on this computer. Remove it there first.");
    }
    case "unknown-mesh":
      return refusal("unknown-mesh", UNKNOWN_MESH);
    default:
      return refusal("failed", FAILED);
  }
}

export function removeMeshRepository(
  store: MeshStore, request: MeshRepositoryEdit, endpointId: string,
): RepositoryEditOutcome {
  if (!request.bindingId) return refusal("invalid", "Removing a repository needs the id of its binding.");
  const outcome = store.unbindRepository(request.projectId, request.bindingId, endpointId);
  switch (outcome.kind) {
    case "removed":
      return { ok: true, bindingId: outcome.binding.bindingId, changed: outcome.binding };
    case "not-found":
      return refusal("not-found", "That repository is not bound to this Mesh.");
    case "not-this-computer":
      return refusal("not-this-computer",
        "That repository is bound on another computer. Only that computer can remove it.");
    case "last-repository":
      return refusal("last-repository", "This is the last repository in the Mesh. Delete the Mesh instead.");
    case "unknown-mesh":
      return refusal("unknown-mesh", UNKNOWN_MESH);
    default:
      return refusal("failed", FAILED);
  }
}

export function unknownMesh(): RepositoryEditOutcome {
  return refusal("unknown-mesh", UNKNOWN_MESH);
}

/** What a chat's checkout gets when it is bound: its neighbours on record and the Engine told. */
function admitBinding(store: MeshStore, project: Project, binding: ProjectBindingSummary, remote?: string): void {
  const root = binding.localPathHint!;
  store.recordIntegrationPeers(project.projectId, binding.repositoryId, readIntegrationMap(root));
  void queueProjectBindingSync(project, {
    summary: binding,
    localRoot: root,
    canonicalRemote: remote ? sanitizedRepositoryRemote(remote) : undefined,
    lastSeenAt: Date.now(),
  }).catch(() => false);
}
