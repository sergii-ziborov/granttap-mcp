/**
 * The checkouts this computer could bind to a Project: the ones it binds to
 * any Project, and the ones its chats work in. A binding is one per
 * repository on a computer, so each repository is listed once — at its bound
 * checkout while that still exists, otherwise where a chat last worked.
 */
import {
  MESH_REPOSITORY_LIST_LIMIT,
  MeshRepositoryCandidate,
  type MeshRepositoryList,
  type MeshRepositoryQuery,
  type ProjectBindingSummary,
  type SessionInfo,
} from "../../../../../packages/protocol/schema";
import { helperRunFolder } from "../../helper-runs";
import type { MeshStore } from "../store";
import { checkoutName, existingPath, type InspectRepository } from "./checkout";

/** How many chat folders one listing reads with Git, most recently worked in first. */
export const MAX_LISTED_FOLDERS = 256;

type Checkout = { path: string; repositoryId: string; seenAt: number };

export type RepositoryListInput = {
  store: MeshStore;
  request: MeshRepositoryQuery;
  endpointId: string;
  sessions: SessionInfo[];
  inspect: InspectRepository;
  now: number;
};

export async function listMeshRepositories(input: RepositoryListInput): Promise<MeshRepositoryList> {
  const { store, request, endpointId } = input;
  const bindings = new Map(store.endpointBindings(endpointId).map((item) => [item.repositoryId, item]));
  const checkouts = new Map<string, Checkout>();
  const keep = (checkout: Checkout) => {
    const known = checkouts.get(checkout.repositoryId);
    if (!known || checkout.seenAt > known.seenAt) checkouts.set(checkout.repositoryId, checkout);
  };
  for (const binding of bindings.values()) {
    const path = binding.localPathHint ? await existingPath(binding.localPathHint) : undefined;
    if (path) keep({ path, repositoryId: binding.repositoryId, seenAt: Number.POSITIVE_INFINITY });
  }
  // Git reads share the runtime's bounded pool, so asking for all of them at once does not flood it.
  const read = await Promise.all(chatFolders(input.sessions).map(async (folder) => {
    const facts = await input.inspect(folder.path);
    const path = facts.worktree ? await existingPath(facts.worktree) : undefined;
    return path ? [{ path, repositoryId: facts.canonicalRepositoryId, seenAt: folder.seenAt }] : [];
  }));
  for (const checkout of read.flat()) keep(checkout);
  const repositories = [...checkouts.values()]
    .flatMap((checkout) => candidate(checkout, bindings.get(checkout.repositoryId), request.projectId, store))
    .filter((item, index, all) => all.findIndex((other) => other.path === item.path) === index)
    .sort((left, right) => Number(right.boundHere) - Number(left.boundHere)
      || left.name.localeCompare(right.name) || left.path.localeCompare(right.path))
    .slice(0, MESH_REPOSITORY_LIST_LIMIT);
  return {
    type: "mesh.repository.list",
    sessionId: request.projectId,
    projectId: request.projectId,
    requestId: request.requestId,
    computerId: endpointId,
    repositories,
    generatedAt: input.now,
  };
}

/** Each folder a chat worked in, once, latest first; a generator's throwaway folder is no checkout. */
function chatFolders(sessions: SessionInfo[]): Array<{ path: string; seenAt: number }> {
  const seen = new Map<string, number>();
  for (const session of sessions) {
    const path = (session.worktree ?? session.cwd)?.trim();
    if (!path || helperRunFolder(path)) continue;
    seen.set(path, Math.max(seen.get(path) ?? 0, session.lastActivityAt));
  }
  return [...seen].map(([path, seenAt]) => ({ path, seenAt }))
    .sort((left, right) => right.seenAt - left.seenAt)
    .slice(0, MAX_LISTED_FOLDERS);
}

function candidate(
  checkout: Checkout, binding: ProjectBindingSummary | undefined, projectId: string, store: MeshStore,
): MeshRepositoryCandidate[] {
  const boundHere = binding != null && binding.projectId === projectId;
  const elsewhere = binding != null && !boundHere ? binding : undefined;
  const other = elsewhere ? store.project(elsewhere.projectId) : undefined;
  const parsed = MeshRepositoryCandidate.safeParse({
    path: checkout.path,
    name: checkoutName(checkout.path),
    repositoryId: checkout.repositoryId,
    boundHere,
    ...(binding && boundHere ? { bindingId: binding.bindingId } : {}),
    ...(elsewhere ? { otherProjectId: elsewhere.projectId } : {}),
    ...(other ? { otherProjectName: other.name } : {}),
  });
  // A path the wire would alter, or one too long to carry, is left out rather than misnamed.
  return parsed.success && parsed.data.path === checkout.path ? [parsed.data] : [];
}
