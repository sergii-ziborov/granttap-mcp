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
    return {
      version: 1,
      projects,
      bindings,
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
