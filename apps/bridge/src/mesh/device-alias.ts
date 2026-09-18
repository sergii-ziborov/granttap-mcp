import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../config/paths";
import { writePrivateFile } from "../config/write-private";

type File = { aliases: Record<string, Record<string, string>> };

export function deviceAliasPath(): string {
  return join(configDir(), "device-aliases.json");
}

function load(): File {
  try {
    const raw = JSON.parse(readFileSync(deviceAliasPath(), "utf8")) as File;
    return raw.aliases && typeof raw.aliases === "object" ? raw : { aliases: {} };
  } catch {
    return { aliases: {} };
  }
}

/** Display name only. Routing and grants always use endpointId. */
export function setDeviceAlias(projectId: string, endpointId: string, alias: string): void {
  const file = load();
  file.aliases[projectId] = { ...file.aliases[projectId], [endpointId]: alias.trim().slice(0, 80) };
  writePrivateFile(deviceAliasPath(), `${JSON.stringify(file, null, 2)}\n`);
}

export function aliasFor(projectId: string, endpointId: string): string | undefined {
  const alias = load().aliases[projectId]?.[endpointId]?.trim();
  return alias || undefined;
}

export function endpointIdFromAlias(projectId: string, name: string): undefined {
  void projectId;
  void name;
  return undefined;
}
