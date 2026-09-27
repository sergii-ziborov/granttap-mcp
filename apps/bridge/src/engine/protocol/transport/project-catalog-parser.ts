import { EngineProtocolError } from "./protocol-base";

export function parseProjectCatalog(value: unknown): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  const page = value as Record<string, unknown>;
  if (!Array.isArray(page.projects) || page.projects.length > 50) invalid();
  let previous = "";
  for (const value of page.projects) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
    const project = value as Record<string, unknown>;
    const id = project.project_id;
    const name = project.name;
    if (typeof id !== "string" || !id || id.length > 128 || /[\x00-\x1f\x7f]/.test(id)
      || id <= previous || typeof name !== "string" || !name || name.length > 160
      || !Number.isSafeInteger(project.created_at) || Number(project.created_at) < 0) invalid();
    previous = id;
  }
  const next = page.next_after_project_id;
  if (next !== null && (page.projects.length !== 50 || next !== previous)) invalid();
}

function invalid(): never {
  throw new EngineProtocolError("Engine Project catalog is invalid");
}
