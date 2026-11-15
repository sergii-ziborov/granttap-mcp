/**
 * The phone reads and changes which repositories a Mesh holds on this
 * computer. Only a controller paired with this computer is answered, and
 * only with a request made in the last two minutes; the answer goes to that
 * controller alone. It is sealed under the Project's key when this computer
 * has the Project, and sent over the pairing otherwise.
 */
import type { RelayClient } from "../../../../../packages/core/relay-client";
import type {
  MeshRepositoryEdit,
  MeshRepositoryEditResult,
  MeshRepositoryQuery,
  SessionInfo,
} from "../../../../../packages/protocol/schema";
import { loadConfig, loadRuntimeConfig, machineConfigPath } from "../../config";
import { sendProjectPayload } from "../../host/session-keys";
import { publishedCatalog } from "../../session-catalog";
import { inspectRepositoryAsync } from "../catalog/repository-inspection";
import { computerId } from "../identity/computer";
import { localMeshStore } from "../local-remote/local";
import type { MeshStore } from "../store";
import { listMeshRepositories } from "./candidates";
import type { InspectRepository } from "./checkout";
import { addMeshRepository, refusal, removeMeshRepository, unknownMesh, type RepositoryEditOutcome } from "./edit";
import { EditRequests } from "./requests";

export const REQUEST_WINDOW_MS = 120_000;

export type RepositoryRequestDependencies = {
  store: () => MeshStore;
  endpoint: () => string;
  meshEnabled: () => boolean;
  paired: (room: string, peer: string) => boolean;
  sessions: (client: RelayClient) => SessionInfo[];
  inspect: InspectRepository;
  now: () => number;
  log: (line: string) => void;
};

const requests = new EditRequests();

/** A controller this computer was paired with, on the route it was paired on. */
export function pairedController(room: string, peer: string): boolean {
  try {
    const machine = loadConfig(machineConfigPath());
    return machine.role === "machine" && machine.room === room
      && (machine.peerPublicKey === peer || machine.extraPeerPublicKeys?.includes(peer) === true);
  } catch {
    return false;
  }
}

export const defaultRepositoryDependencies: RepositoryRequestDependencies = {
  store: localMeshStore,
  endpoint: () => computerId(),
  meshEnabled: () => loadRuntimeConfig().meshEnabled,
  paired: pairedController,
  sessions: (client) => {
    const catalog = publishedCatalog(client);
    return catalog ? [...catalog.sessions, ...(catalog.history ?? [])] : [];
  },
  inspect: inspectRepositoryAsync,
  now: Date.now,
  log: (line) => { process.stderr.write(`[monitor] mesh: ${line}\n`); },
};

export async function handleMeshRepositoryRequest(
  client: RelayClient,
  payload: MeshRepositoryQuery | MeshRepositoryEdit,
  peer: string | undefined,
  publish: () => Promise<void>,
  deps: RepositoryRequestDependencies = defaultRepositoryDependencies,
): Promise<boolean> {
  if (!peer || !Number.isFinite(payload.createdAt)
    || Math.abs(deps.now() - payload.createdAt) > REQUEST_WINDOW_MS || !deps.paired(client.room, peer)) return false;
  return payload.type === "mesh.repository.query"
    ? answerQuery(client, payload, peer, deps)
    : answerEdit(client, payload, peer, publish, deps);
}

async function answerQuery(
  client: RelayClient, request: MeshRepositoryQuery, peer: string, deps: RepositoryRequestDependencies,
): Promise<boolean> {
  if (!deps.meshEnabled()) return false;
  const store = deps.store();
  if (!store.project(request.projectId)) return false;
  const list = await listMeshRepositories({
    store, request, endpointId: deps.endpoint(), sessions: deps.sessions(client), inspect: deps.inspect, now: deps.now(),
  });
  await sendProjectPayload(client, list, "phone", { peerPublicKey: peer, reliable: false, ttlMs: 60_000 })
    .catch(() => {});
  return true;
}

async function answerEdit(
  client: RelayClient, request: MeshRepositoryEdit, peer: string,
  publish: () => Promise<void>, deps: RepositoryRequestDependencies,
): Promise<boolean> {
  const recall = requests.recall(`${client.room}\0${peer}`, request, deps.now());
  if (recall.kind === "conflict") return false;
  if (recall.kind === "replay") {
    await send(client, peer, await recall.result, deps);
    return true;
  }
  const work = edit(request, deps).then((outcome) => {
    if (outcome.changed) {
      deps.log(`repository ${outcome.changed.repositoryId} ${request.action === "add" ? "added to" : "removed from"} `
        + `${request.projectId} by the person`);
      void publish().catch(() => {});
    }
    return editResult(request, outcome, deps.now());
  });
  recall.remember(work);
  await send(client, peer, await work, deps);
  return true;
}

async function edit(request: MeshRepositoryEdit, deps: RepositoryRequestDependencies): Promise<RepositoryEditOutcome> {
  try {
    if (!deps.meshEnabled()) return refusal("mesh-disabled", "The Mesh is turned off on this computer.");
    const store = deps.store();
    if (!store.project(request.projectId)) return unknownMesh();
    return request.action === "add"
      ? await addMeshRepository(store, request, deps.endpoint(), deps.inspect)
      : removeMeshRepository(store, request, deps.endpoint());
  } catch {
    return refusal("failed", "The Mesh could not be changed on this computer. Try again.");
  }
}

export function editResult(
  request: MeshRepositoryEdit, outcome: RepositoryEditOutcome, now: number,
): MeshRepositoryEditResult {
  return {
    type: "mesh.repository.edit.result",
    sessionId: request.projectId,
    projectId: request.projectId,
    requestId: request.requestId,
    action: request.action,
    ok: outcome.ok,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    ...(outcome.detail ? { detail: outcome.detail.slice(0, 300) } : {}),
    ...(outcome.bindingId ? { bindingId: outcome.bindingId } : {}),
    generatedAt: now,
  };
}

/** A Project this computer has is answered under its key; any other is answered over the pairing, minting no key. */
async function send(
  client: RelayClient, peer: string, result: MeshRepositoryEditResult, deps: RepositoryRequestDependencies,
): Promise<void> {
  const options = { peerPublicKey: peer, ttlMs: 15 * 60_000 };
  const known = deps.store().project(result.projectId) != null;
  await (known ? sendProjectPayload(client, result, "phone", options) : client.sendToPeer(result, peer, options))
    .catch(() => {});
}

/** Forget every remembered edit; for a fresh runtime state. */
export function resetRepositoryRequests(): void {
  requests.clear();
}
