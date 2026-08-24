/** The on-disk shape of one computer's Mesh state, and how it is read back. */
import {
  ExecutionSessionLink,
  HandoffReceipt,
  MeshEvent,
  MeshTask,
  Project,
  ResourceClaim,
  TaskDependency,
  type ExecutionSessionLink as ExecutionValue,
  type HandoffReceipt as ReceiptValue,
  type MeshEvent as MeshEventValue,
  type MeshTask as TaskValue,
  type Project as ProjectValue,
  type ResourceClaim as ResourceClaimValue,
  type TaskDependency as DependencyValue,
} from "../../../../packages/protocol/schema";
import { readFileSync } from "node:fs";

export type StoreState = {
  version: 1;
  projects: ProjectValue[];
  tasks: TaskValue[];
  executions: ExecutionValue[];
  claims: ResourceClaimValue[];
  dependencies: DependencyValue[];
  events: MeshEventValue[];
  receipts: ReceiptValue[];
};

const EMPTY: StoreState = {
  version: 1, projects: [], tasks: [], executions: [], claims: [], dependencies: [], events: [], receipts: [],
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
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<StoreState>;
    return {
      version: 1,
      projects: parsedArray(value.projects, Project),
      tasks: parsedArray(value.tasks, MeshTask),
      executions: parsedArray(value.executions, ExecutionSessionLink),
      claims: parsedArray(value.claims, ResourceClaim),
      dependencies: parsedArray(value.dependencies, TaskDependency),
      events: parsedArray(value.events, MeshEvent),
      receipts: parsedArray(value.receipts, HandoffReceipt),
    };
  } catch {
    return structuredClone(EMPTY);
  }
}
