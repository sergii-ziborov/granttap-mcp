import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { configDir } from "../../../bridge/src/config";
import { writePrivateFile } from "../../../bridge/src/config/write-private";

export const PENDING_TTL_MS = 15 * 60_000;

export type PendingAuth = {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  createdAt: number;
};

type StoredPending = {
  client: OAuthClientInformationFull;
  createdAt: number;
  params: Omit<AuthorizationParams, "resource"> & { resource?: string };
};

function pendingPath(): string {
  return join(configDir(), "mcp-oauth-pending.json");
}

export function loadPending(): Map<string, PendingAuth> {
  const pending = new Map<string, PendingAuth>();
  try {
    if (!existsSync(pendingPath())) return pending;
    const raw = JSON.parse(readFileSync(pendingPath(), "utf8")) as Record<string, StoredPending>;
    const now = Date.now();
    for (const [id, entry] of Object.entries(raw)) {
      if (!entry?.client || !entry.params?.redirectUri || now - entry.createdAt > PENDING_TTL_MS) continue;
      pending.set(id, {
        client: entry.client,
        createdAt: entry.createdAt,
        params: {
          ...entry.params,
          resource: entry.params.resource ? new URL(entry.params.resource) : undefined,
        } as AuthorizationParams,
      });
    }
  } catch {
    return pending;
  }
  return pending;
}

export function savePending(pending: Map<string, PendingAuth>): void {
  const now = Date.now();
  const raw: Record<string, StoredPending> = {};
  for (const [id, entry] of pending) {
    if (now - entry.createdAt > PENDING_TTL_MS) continue;
    raw[id] = {
      client: entry.client,
      createdAt: entry.createdAt,
      params: {
        ...entry.params,
        resource: entry.params.resource?.href,
      },
    };
  }
  writePrivateFile(pendingPath(), JSON.stringify(raw, null, 2) + "\n");
}
