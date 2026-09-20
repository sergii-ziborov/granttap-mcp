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
  type ExecutionSessionLink as ExecutionValue,
  type HandoffReceipt as ReceiptValue,
  type IntegrationPeer as IntegrationPeerValue,
  type MeshEvent as MeshEventValue,
  type MeshTask as TaskValue,
  type Project as ProjectValue,
  type ProjectBindingSummary as BindingValue,
  type ResourceClaim as ResourceClaimValue,
  type TaskDependency as DependencyValue,
} from "../../../../../packages/protocol/schema";
import { lstatSync, readFileSync } from "node:fs";
import { z } from "zod";
import { capsuleHash } from "../handoff";

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
  receipts: ReceiptValue[];
  migrations: CapsuleMigration[];
  releasedClaims: ReleasedClaim[];
};

const EMPTY: StoreState = {
  version: 1, projects: [], bindings: [], peers: [], tasks: [], executions: [], claims: [],
  dependencies: [], events: [], receipts: [], migrations: [], releasedClaims: [],
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
        receipts: parsedArray(value.receipts, HandoffReceipt),
        migrations: parsedArray(value.migrations, CapsuleMigration).slice(-MAX_STORE_MIGRATIONS),
        releasedClaims: parsedArray(value.releasedClaims, ReleasedClaim).slice(-MAX_RELEASED_CLAIMS),
      }),
    };
  } catch {
    return { status: "corrupt", state: emptyStoreState() };
  }
}

export function loadStoreState(path: string): StoreState {
  return readStoreState(path).state;
}

/**
 * Rejoin a chat that was split across two Tasks.
 *
 * A Task used to be looked up by computer as well as by chat, so a machine
 * renamed by the network it joined, or a chat read from a second machine,
 * minted a second Task for the same conversation. Nothing swept the older one:
 * its execution belongs to a computer that no longer reports, so it was never
 * seen to vanish, and the chat stayed listed twice.
 *
 * A provider session id identifies one conversation, so its executions belong
 * to one Task. The oldest surviving Task wins, because it is the one other
 * records — dependencies, claims, events — were written against.
 */
function collapseSplitChats(state: StoreState): StoreState {
  const taskById = new Map(state.tasks.map((task) => [task.taskId, task]));
  const winnerByChat = new Map<string, string>();
  const rewritten = new Map<string, string>();

  const claim = (chat: string, taskId: string): void => {
    const held = winnerByChat.get(chat);
    if (held == null) {
      winnerByChat.set(chat, taskId);
      return;
    }
    if (held === taskId) return;
    const [keep, drop] = olderFirst(taskById.get(held), taskById.get(taskId))
      ?? [held, taskId];
    winnerByChat.set(chat, keep);
    rewritten.set(drop, keep);
  };

  // An execution is identified by computer, provider, and chat together, so two
  // Tasks for one chat on one computer share an execution and the other Task is
  // left carrying none. Walking executions alone would never see it. A Task
  // names its own chat in `ownerSessionId`, and a session id is unique on its
  // own, so both are claims about the same conversation.
  for (const execution of [...state.executions].sort((a, b) => a.startedAt - b.startedAt)) {
    claim(execution.sessionId, execution.taskId);
  }
  for (const task of [...state.tasks].sort((a, b) => a.createdAt - b.createdAt)) {
    if (task.ownerSessionId) claim(task.ownerSessionId, task.taskId);
  }
  if (rewritten.size === 0) return state;
  // A Task chosen as a winner early can be dropped later, so a rewrite is
  // followed to its end rather than applied once.
  const target = (taskId: string): string => {
    let current = taskId;
    for (let step = 0; step < state.tasks.length; step += 1) {
      const next = rewritten.get(current);
      if (next == null || next === current) break;
      current = next;
    }
    return current;
  };
  const scoped = <T extends { taskId: string }>(item: T): T => ({ ...item, taskId: target(item.taskId) });
  // A dependency names two Tasks, and both may have moved; two that became
  // one are no dependency at all.
  const dependencies = new Map<string, DependencyValue>();
  for (const item of state.dependencies) {
    const next = { ...item, taskId: target(item.taskId), dependsOnTaskId: target(item.dependsOnTaskId) };
    if (next.taskId === next.dependsOnTaskId) continue;
    dependencies.set(`${next.taskId}\0${next.dependsOnTaskId}`, next);
  }
  // A capsule carries its Task id and is named by its hash; moving the id
  // changes the hash, so every receipt that named the old hash names the new
  // one, and the move itself is written down for a receipt still on its way.
  const now = Date.now();
  const migrations = new Map(state.migrations.map((item) => [item.capsuleHashFrom, item]));
  const rehashed = new Map<string, string>();
  const events = state.events.map((event) => {
    const next = rescopedEvent(event, target);
    const before = event.payload.capsule;
    const after = next.payload.capsule;
    if (before && after && event.taskId !== next.taskId) {
      const from = capsuleHash(before);
      const to = capsuleHash(after);
      rehashed.set(from, to);
      migrations.set(from, {
        at: now, taskIdFrom: event.taskId, taskIdTo: next.taskId, capsuleHashFrom: from, capsuleHashTo: to,
      });
    }
    return next;
  });
  const rehash = (hash: string): string => rehashed.get(hash) ?? hash;
  return {
    ...state,
    tasks: state.tasks.filter((task) => target(task.taskId) === task.taskId),
    executions: state.executions.map(scoped),
    claims: state.claims.map(scoped),
    dependencies: [...dependencies.values()],
    events: events.map((event) => event.payload.receipt
      ? { ...event, payload: { ...event.payload, receipt: { ...event.payload.receipt, capsuleHash: rehash(event.payload.receipt.capsuleHash) } } }
      : event),
    // A receipt decides who owns a chat, so it must name the surviving Task and its capsule.
    receipts: state.receipts.map((item) => ({ ...scoped(item), capsuleHash: rehash(item.capsuleHash) })),
    migrations: [...migrations.values()].slice(-MAX_STORE_MIGRATIONS),
    releasedClaims: state.releasedClaims,
  };
}

/**
 * An event names its Task more than once: as the scope it was published in,
 * and inside what it carries — a claim, a capsule, a receipt, a dependency.
 * Every name must move together, or the snapshot's own schema refuses the
 * event and the whole Project stops being published.
 */
function rescopedEvent(event: MeshEventValue, target: (taskId: string) => string): MeshEventValue {
  const taskId = target(event.taskId);
  const payload = { ...event.payload };
  if (payload.claim) payload.claim = { ...payload.claim, taskId: target(payload.claim.taskId) };
  if (payload.receipt) payload.receipt = { ...payload.receipt, taskId: target(payload.receipt.taskId) };
  if (payload.capsule) {
    payload.capsule = {
      ...payload.capsule,
      taskId: target(payload.capsule.taskId),
      dependencies: [...new Set(payload.capsule.dependencies.map(target))].filter((id) => id !== taskId),
    };
  }
  if (payload.dependsOnTaskId) payload.dependsOnTaskId = target(payload.dependsOnTaskId);
  return { ...event, taskId, sessionId: taskId, payload };
}

/** The Task to keep first, or nothing when either side is already gone. */
function olderFirst(
  left: StoreState["tasks"][number] | undefined,
  right: StoreState["tasks"][number] | undefined,
): [string, string] | undefined {
  if (!left || !right) return undefined;
  return left.createdAt <= right.createdAt
    ? [left.taskId, right.taskId]
    : [right.taskId, left.taskId];
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
