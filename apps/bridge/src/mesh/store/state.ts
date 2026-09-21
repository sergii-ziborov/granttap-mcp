/** The on-disk shape of one computer's Mesh state, and how it is read back. */
import {
  ExecutionSessionLink,
  HandoffReceipt,
  IntegrationPeer,
  MeshEvent,
  MeshTask,
  Project,
  ProjectBindingSummary,
  ResourceClaim,
  TaskDependency,
  ProjectKnowledgeRecord,
  type ExecutionSessionLink as ExecutionValue,
  type HandoffReceipt as ReceiptValue,
  type IntegrationPeer as IntegrationPeerValue,
  type MeshEvent as MeshEventValue,
  type MeshTask as TaskValue,
  type Project as ProjectValue,
  type ProjectBindingSummary as BindingValue,
  type ResourceClaim as ResourceClaimValue,
  type TaskDependency as DependencyValue,
  type ProjectKnowledgeRecord as KnowledgeValue,
} from "../../../../../packages/protocol/schema";
import { lstatSync, readFileSync } from "node:fs";
import { z } from "zod";
import { collapseSplitChats } from "./rejoin";

const MAX_STORE_BYTES = 4 * 1_024 * 1_024;

/**
 * A capsule rewritten when two Tasks were rejoined, on record: its hash
 * changed with its Task id, and a receipt that names the old hash is still a
 * receipt for it. Kept locally only; nothing on the wire carries it.
 */
export const CapsuleMigration = z.object({
  at: z.number().nonnegative(),
  taskIdFrom: z.string().min(1).max(128),
  taskIdTo: z.string().min(1).max(128),
  capsuleHashFrom: z.string().regex(/^[0-9a-f]{64}$/),
  capsuleHashTo: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type CapsuleMigration = z.infer<typeof CapsuleMigration>;

/**
 * A claim that was released, on record until the claim itself would have
 * expired. Snapshots merge claims by id, so a computer that was away, or a
 * copy that came round through another phone, would otherwise bring a
 * released claim back as if nothing had happened.
 */
export const ReleasedClaim = z.object({
  claimId: z.string().min(1).max(128),
  releasedAt: z.number().nonnegative(),
  expiresAt: z.number().positive(),
}).strict();
export type ReleasedClaim = z.infer<typeof ReleasedClaim>;

export type StoreState = {
  version: 1;
  projects: ProjectValue[];
  bindings: BindingValue[];
  peers: IntegrationPeerValue[];
  tasks: TaskValue[];
  executions: ExecutionValue[];
  claims: ResourceClaimValue[];
  dependencies: DependencyValue[];
  events: MeshEventValue[];
  knowledge: KnowledgeValue[];
  receipts: ReceiptValue[];
  migrations: CapsuleMigration[];
  releasedClaims: ReleasedClaim[];
};

const EMPTY: StoreState = {
  version: 1, projects: [], bindings: [], peers: [], tasks: [], executions: [], claims: [],
  dependencies: [], events: [], knowledge: [], receipts: [], migrations: [], releasedClaims: [],
};

export const MAX_STORE_PEERS = 256;
export const MAX_STORE_MIGRATIONS = 64;
export const MAX_RELEASED_CLAIMS = 256;

function parsedArray<T>(value: unknown, schema: { safeParse: (input: unknown) => { success: boolean; data?: T } }): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = schema.safeParse(item);
    return parsed.success && parsed.data ? [parsed.data] : [];
  });
}


export function emptyStoreState(): StoreState {
  return structuredClone(EMPTY);
}

/**
 * Why a file could not be used. A missing file is a fresh start; the rest are
 * files that exist and say something the store cannot read, which the store
 * keeps aside rather than writes over.
 */
export type StoreLoadStatus = "ok" | "missing" | "not_file" | "too_large" | "corrupt";
export type StoreLoad = { status: StoreLoadStatus; state: StoreState };

export function readStoreState(path: string): StoreLoad {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    return { status: "missing", state: emptyStoreState() };
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) return { status: "not_file", state: emptyStoreState() };
  if (metadata.size > MAX_STORE_BYTES) return { status: "too_large", state: emptyStoreState() };
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<StoreState> | null;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { status: "corrupt", state: emptyStoreState() };
    }
    const projects = parsedArray(value.projects, Project);
    const bindings = validBindings(
      parsedArray(value.bindings, ProjectBindingSummary),
      new Set(projects.map((project) => project.projectId)),
    );
    return {
      status: "ok",
      state: collapseSplitChats({
        version: 1,
        projects,
        bindings,
        peers: parsedArray(value.peers, IntegrationPeer)
          .filter((peer) => projects.some((project) => project.projectId === peer.projectId))
          .slice(-MAX_STORE_PEERS),
        tasks: parsedArray(value.tasks, MeshTask),
        executions: parsedArray(value.executions, ExecutionSessionLink),
        claims: parsedArray(value.claims, ResourceClaim),
        dependencies: parsedArray(value.dependencies, TaskDependency),
        events: parsedArray(value.events, MeshEvent),
        knowledge: parsedArray(value.knowledge, ProjectKnowledgeRecord)
          .filter((item) => projects.some((project) => project.projectId === item.projectId))
          .slice(-256),
        receipts: parsedArray(value.receipts, HandoffReceipt),
        migrations: parsedArray(value.migrations, CapsuleMigration).slice(-MAX_STORE_MIGRATIONS),
        releasedClaims: parsedArray(value.releasedClaims, ReleasedClaim).slice(-MAX_RELEASED_CLAIMS),
      }, path, MAX_STORE_MIGRATIONS),
    };
  } catch {
    return { status: "corrupt", state: emptyStoreState() };
  }
}

export function loadStoreState(path: string): StoreState {
  return readStoreState(path).state;
}

function validBindings(bindings: BindingValue[], projectIds: ReadonlySet<string>): BindingValue[] {
  const ids = new Set<string>();
  const locations = new Set<string>();
  return bindings.filter((binding) => {
    const location = `${binding.endpointId}\0${binding.repositoryId}`;
    if (!projectIds.has(binding.projectId)
      || ids.has(binding.bindingId)
      || locations.has(location)) return false;
    ids.add(binding.bindingId);
    locations.add(location);
    return true;
  });
}
