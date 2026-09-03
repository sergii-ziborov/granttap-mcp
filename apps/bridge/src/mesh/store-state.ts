/** The on-disk shape of one computer's Mesh state, and how it is read back. */
import {
  ExecutionSessionLink,
  HandoffReceipt,
  MeshEvent,
  MeshTask,
  Project,
  ProjectBindingSummary,
  ResourceClaim,
  TaskDependency,
  type ExecutionSessionLink as ExecutionValue,
  type HandoffReceipt as ReceiptValue,
  type MeshEvent as MeshEventValue,
  type MeshTask as TaskValue,
  type Project as ProjectValue,
  type ProjectBindingSummary as BindingValue,
  type ResourceClaim as ResourceClaimValue,
  type TaskDependency as DependencyValue,
} from "../../../../packages/protocol/schema";
import { lstatSync, readFileSync } from "node:fs";

const MAX_STORE_BYTES = 4 * 1_024 * 1_024;

export type StoreState = {
  version: 1;
  projects: ProjectValue[];
  bindings: BindingValue[];
  tasks: TaskValue[];
  executions: ExecutionValue[];
  claims: ResourceClaimValue[];
  dependencies: DependencyValue[];
  events: MeshEventValue[];
  receipts: ReceiptValue[];
};

const EMPTY: StoreState = {
  version: 1, projects: [], bindings: [], tasks: [], executions: [], claims: [],
  dependencies: [], events: [], receipts: [],
};

function parsedArray<T>(value: unknown, schema: { safeParse: (input: unknown) => { success: boolean; data?: T } }): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = schema.safeParse(item);
    return parsed.success && parsed.data ? [parsed.data] : [];
  });
}


export function loadStoreState(path: string): StoreState {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_STORE_BYTES) {
      return structuredClone(EMPTY);
    }
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<StoreState>;
    const projects = parsedArray(value.projects, Project);
    const bindings = validBindings(
      parsedArray(value.bindings, ProjectBindingSummary),
      new Set(projects.map((project) => project.projectId)),
    );
    return collapseSplitChats({
      version: 1,
      projects,
      bindings,
      tasks: parsedArray(value.tasks, MeshTask),
      executions: parsedArray(value.executions, ExecutionSessionLink),
      claims: parsedArray(value.claims, ResourceClaim),
      dependencies: parsedArray(value.dependencies, TaskDependency),
      events: parsedArray(value.events, MeshEvent),
      receipts: parsedArray(value.receipts, HandoffReceipt),
    });
  } catch {
    return structuredClone(EMPTY);
  }
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
  for (const execution of state.executions) {
    const chat = `${execution.provider}\u0000${execution.sessionId}`;
    const held = winnerByChat.get(chat);
    if (held == null) {
      winnerByChat.set(chat, execution.taskId);
      continue;
    }
    if (held === execution.taskId) continue;
    const [keep, drop] = olderFirst(taskById.get(held), taskById.get(execution.taskId))
      ?? [held, execution.taskId];
    winnerByChat.set(chat, keep);
    rewritten.set(drop, keep);
  }
  if (rewritten.size === 0) return state;
  const target = (taskId: string): string => rewritten.get(taskId) ?? taskId;
  return {
    ...state,
    tasks: state.tasks.filter((task) => !rewritten.has(task.taskId)),
    executions: state.executions.map((item) => ({ ...item, taskId: target(item.taskId) })),
    claims: state.claims.map((item) => ({ ...item, taskId: target(item.taskId) })),
    dependencies: state.dependencies.map((item) => ({ ...item, taskId: target(item.taskId) })),
    events: state.events.map((item) => ({ ...item, taskId: target(item.taskId) })),
    // A receipt decides who owns a chat, so it must name the surviving Task.
    receipts: state.receipts.map((item) => ({ ...item, taskId: target(item.taskId) })),
  };
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
