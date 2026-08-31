import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

function digest(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value).digest("base64url").slice(0, 24)}`;
}

/** A public repository hint: host/path only, never credentials or URL query data. */
export function sanitizedRepositoryRemote(remote: string): string | undefined {
  const trimmed = remote.trim().replace(/\/+$/, "");
  if (!trimmed) return undefined;
  const scp = trimmed.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
  if (scp && !trimmed.includes("://")) {
    return `${scp[1]}/${scp[2]?.split(/[?#]/, 1)[0]}`
      .replace(/\.git$/i, "").toLowerCase();
  }
  try {
    const parsed = new URL(trimmed);
    if (!parsed.hostname) return undefined;
    return `${parsed.hostname}${parsed.pathname}`.replace(/\.git$/i, "").toLowerCase();
  } catch {
    if (/^[a-z0-9.-]+\/[a-z0-9._/-]+(?:\.git)?$/i.test(trimmed)) {
      return trimmed.replace(/\.git$/i, "").toLowerCase();
    }
    return undefined;
  }
}

export function canonicalRepositoryIdentity(remote: string | undefined, root: string): string {
  const normalized = remote ? sanitizedRepositoryRemote(remote) : undefined;
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

export function projectBindingIdentity(
  projectId: string,
  endpointId: string,
  canonicalRepositoryId: string,
): string {
  return digest(
    "binding",
    `${projectId.trim()}\0${endpointId.trim()}\0${canonicalRepositoryId.trim().toLowerCase()}`,
  );
}

export function taskIdentity(projectId: string, provider: string, sessionId: string): string {
  return digest("task", `${projectId}\0${provider.trim().toLowerCase()}\0${sessionId.trim()}`);
}
