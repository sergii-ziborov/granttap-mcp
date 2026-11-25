/** Engine 0.1.9 `workstation.load` / `workstation.space`, from linked SweepLoom. Read-only. */

export type EngineWorkstationSession = {
  kind: string; name?: string | null; processes: number; rss_bytes: number;
  cpu_percent_tenths: number; project?: string | null;
};
export type EngineWorkstationLoad = {
  captured_at_ms: number; memory_total_bytes: number; memory_used_bytes: number;
  memory_available_bytes: number; swap_total_bytes: number; swap_used_bytes: number;
  cpu_percent_tenths: number; logical_cores: number; physical_cores?: number | null;
  volumes: { mount: string; total_bytes: number; available_bytes: number; home: boolean }[];
  sessions: EngineWorkstationSession[];
};
export type EngineWorkstationItem = { title: string; path: string; bytes: number; kind: string; partial: boolean };
export type EngineWorkstationGroup = {
  id: string; title: string; section: string; bytes: number; regenerable_bytes: number;
  partial: boolean; items: EngineWorkstationItem[];
};
export type EngineWorkstationSpace = {
  started_at_ms: number; duration_ms: number; complete: boolean; project_roots: number;
  groups: EngineWorkstationGroup[];
};

export type WorkstationEngineOperation =
  | { operation: "workstation.load"; input: { max_sessions?: number } }
  | { operation: "workstation.space"; input: { budget_ms: number; max_items?: number } };
export type WorkstationEngineResult =
  | { operation: "workstation.load"; load: EngineWorkstationLoad }
  | { operation: "workstation.space"; space: EngineWorkstationSpace };

type Invalid = () => never;

export function parseWorkstationResult(result: Record<string, unknown>, invalid: Invalid): boolean {
  if (result.operation === "workstation.load") {
    parseLoad(object(result.load, invalid), invalid);
    return true;
  }
  if (result.operation !== "workstation.space") return false;
  const space = object(result.space, invalid);
  for (const key of ["started_at_ms", "duration_ms", "project_roots"]) count(space[key], invalid);
  if (typeof space.complete !== "boolean") invalid();
  for (const raw of list(space.groups, 16, invalid)) {
    const group = object(raw, invalid);
    for (const key of ["id", "title", "section"]) text(group[key], invalid);
    count(group.bytes, invalid); count(group.regenerable_bytes, invalid);
    if (typeof group.partial !== "boolean") invalid();
    for (const rawItem of list(group.items, 12, invalid)) {
      const item = object(rawItem, invalid);
      for (const key of ["title", "path", "kind"]) text(item[key], invalid);
      count(item.bytes, invalid);
      if (typeof item.partial !== "boolean") invalid();
    }
  }
  return true;
}

function parseLoad(load: Record<string, unknown>, invalid: Invalid): void {
  for (const key of ["captured_at_ms", "memory_total_bytes", "memory_used_bytes", "memory_available_bytes",
    "swap_total_bytes", "swap_used_bytes", "cpu_percent_tenths", "logical_cores"]) count(load[key], invalid);
  if (load.physical_cores != null) count(load.physical_cores, invalid);
  for (const raw of list(load.volumes, 8, invalid)) {
    const volume = object(raw, invalid);
    text(volume.mount, invalid); count(volume.total_bytes, invalid); count(volume.available_bytes, invalid);
    if (typeof volume.home !== "boolean") invalid();
  }
  for (const raw of list(load.sessions, 16, invalid)) {
    const session = object(raw, invalid);
    text(session.kind, invalid);
    if (session.name != null) text(session.name, invalid);
    if (session.project != null) text(session.project, invalid);
    count(session.processes, invalid); count(session.rss_bytes, invalid); count(session.cpu_percent_tenths, invalid);
  }
}

function object(value: unknown, invalid: Invalid): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function list(value: unknown, max: number, invalid: Invalid): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid();
  return value as unknown[];
}

function count(value: unknown, invalid: Invalid): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid();
}

function text(value: unknown, invalid: Invalid): void {
  if (typeof value !== "string" || value.length > 512) invalid();
}
