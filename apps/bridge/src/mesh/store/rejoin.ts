import { lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MeshEvent as MeshEventValue, TaskDependency as DependencyValue } from "../../../../../packages/protocol/schema";
import { capsuleHash } from "../handoff";
import type { StoreState } from "./state";

/** Only a locally persisted legacy identity can relate former hostname endpoints. */
function legacyEndpointAliases(storePath: string): Map<string, string> {
  const path = join(dirname(storePath), "computer.json");
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 2_048) return new Map();
    const value = JSON.parse(readFileSync(path, "utf8")) as {
      computerId?: unknown; names?: unknown;
    };
    if (typeof value.computerId !== "string" || !Array.isArray(value.names)
      || value.names.length > 16 || !value.names.includes(value.computerId)) return new Map();
    const aliases = new Map<string, string>();
    for (const name of value.names) {
      if (typeof name !== "string" || !name || name.length > 128) return new Map();
      aliases.set(name, value.computerId);
    }
    return aliases;
  } catch { return new Map(); }
}

export function collapseSplitChats(
  state: StoreState, storePath: string, maxMigrations: number,
): StoreState {
  const aliases = legacyEndpointAliases(storePath);
  const taskById = new Map<string, StoreState["tasks"][number]>();
  const ambiguousTaskIds = new Set<string>();
  for (const task of state.tasks) {
    if (taskById.has(task.taskId)) ambiguousTaskIds.add(task.taskId);
    else taskById.set(task.taskId, task);
  }
  const winnerByChat = new Map<string, string>();
  const rewritten = new Map<string, string>();
  const scopesByOwner = new Map<string, Set<string>>();

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

  // The native ID alone is not a Task identity: Project, provider, endpoint and workspace
  // remain separate unless this local computer recorded a former hostname.
  for (const execution of [...state.executions].sort((a, b) => a.startedAt - b.startedAt)) {
    const task = ambiguousTaskIds.has(execution.taskId) ? undefined : taskById.get(execution.taskId);
    if (!task) continue;
    const scope = JSON.stringify([
      task.projectId, execution.provider,
      aliases.get(execution.computerId) ?? execution.computerId,
      execution.workspace, execution.sessionId,
    ]);
    const owner = JSON.stringify([task.projectId, execution.sessionId]);
    const candidates = scopesByOwner.get(owner) ?? new Set<string>();
    candidates.add(scope);
    scopesByOwner.set(owner, candidates);
    claim(scope, execution.taskId);
  }
  for (const task of [...state.tasks].sort((a, b) => a.createdAt - b.createdAt)) {
    if (!task.ownerSessionId || ambiguousTaskIds.has(task.taskId)) continue;
    const scopes = scopesByOwner.get(JSON.stringify([task.projectId, task.ownerSessionId]));
    if (scopes?.size === 1) claim([...scopes][0]!, task.taskId);
  }
  if (rewritten.size === 0) return state;
  return applyChatRewrites(state, rewritten, maxMigrations);
}

function applyChatRewrites(
  state: StoreState, rewritten: Map<string, string>, maxMigrations: number,
): StoreState {
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
    migrations: [...migrations.values()].slice(-maxMigrations),
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
