import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

function digest(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value).digest("base64url").slice(0, 24)}`;
}

function normalizedRemote(remote: string): string | undefined {
  const trimmed = remote.trim().replace(/\/+$/, "");
  if (!trimmed) return undefined;
  const scp = trimmed.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
  if (scp && !trimmed.includes("://")) {
    return `${scp[1]}/${scp[2]}`.replace(/\.git$/i, "").toLowerCase();
  }
  try {
    const parsed = new URL(trimmed);
    return `${parsed.hostname}${parsed.pathname}`.replace(/\.git$/i, "").toLowerCase();
  } catch {
    return trimmed.replace(/\.git$/i, "").toLowerCase();
  }
}

export function canonicalRepositoryIdentity(remote: string | undefined, root: string): string {
  const normalized = remote ? normalizedRemote(remote) : undefined;
  if (normalized) return normalized;
  try {
    return `local:${realpathSync(root)}`;
  } catch {
    return `local:${root}`;
  }
}

export function projectIdentity(canonicalRepositoryId: string): string {
  return digest("project", canonicalRepositoryId.trim().toLowerCase());
}

export function taskIdentity(projectId: string, provider: string, sessionId: string): string {
  return digest("task", `${projectId}\0${provider.trim().toLowerCase()}\0${sessionId.trim()}`);
}
