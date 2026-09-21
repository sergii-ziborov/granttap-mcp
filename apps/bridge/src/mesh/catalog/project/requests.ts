import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ProjectCapabilityRequest,
  ProjectCapabilityRequestSet,
  type ProjectCapabilityRequest as RequestValue,
  type ProjectCapabilityRequestSet as RequestSetValue,
} from "../../../../../../packages/protocol/schema";
import { writePrivateFile } from "../../../config/access/write-private";
import { configDir } from "../../../config/runtime/paths";

const MAX_REQUESTS = 128;

function path(): string {
  return join(configDir(), "project-capability-requests.json");
}

function key(value: Pick<RequestValue, "projectId" | "kind" | "name">): string {
  return `${value.projectId}\0${value.kind}\0${value.name.toLowerCase()}`;
}

export function loadProjectCapabilityRequests(): RequestValue[] {
  try {
    const raw = JSON.parse(readFileSync(path(), "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
      const parsed = ProjectCapabilityRequest.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }).sort((a, b) => a.requestedAt - b.requestedAt).slice(-MAX_REQUESTS);
  } catch {
    return [];
  }
}

export function projectCapabilityRequests(projectId: string): RequestValue[] {
  return loadProjectCapabilityRequests().filter((item) => item.projectId === projectId);
}

export function saveProjectCapabilityRequest(input: RequestSetValue): RequestValue {
  const request = ProjectCapabilityRequestSet.parse(input);
  const value: RequestValue = {
    projectId: request.projectId,
    kind: request.kind,
    name: request.name,
    source: request.source,
    version: request.version,
    requestedAt: request.requestedAt,
  };
  saveMerged([value]);
  return value;
}

export function mergeProjectCapabilityRequests(input: RequestValue[]): void {
  saveMerged(input.map((item) => ProjectCapabilityRequest.parse(item)));
}

function saveMerged(input: RequestValue[]): void {
  const byKey = new Map(loadProjectCapabilityRequests().map((item) => [key(item), item]));
  for (const item of input) {
    const held = byKey.get(key(item));
    if (!held || item.requestedAt >= held.requestedAt) byKey.set(key(item), item);
  }
  const bounded = [...byKey.values()]
    .sort((a, b) => a.requestedAt - b.requestedAt)
    .slice(-MAX_REQUESTS);
  writePrivateFile(path(), `${JSON.stringify(bounded, null, 2)}\n`);
}
