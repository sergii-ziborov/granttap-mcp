import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { configDir } from "../../../bridge/src/config";

export type StoredToken = {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
};

type OAuthStoreFile = {
  clients: Record<string, OAuthClientInformationFull>;
  tokens: Record<string, StoredToken>;
};

function storePath(): string {
  return join(configDir(), "mcp-oauth.json");
}

export function loadOAuthStore(): OAuthStoreFile {
  try {
    if (!existsSync(storePath())) return { clients: {}, tokens: {} };
    const raw = JSON.parse(readFileSync(storePath(), "utf8")) as OAuthStoreFile;
    return { clients: raw.clients ?? {}, tokens: raw.tokens ?? {} };
  } catch {
    return { clients: {}, tokens: {} };
  }
}

export function saveOAuthStore(store: OAuthStoreFile): void {
  mkdirSync(configDir(), { recursive: true });
  const path = storePath();
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export class GrantTapClientsStore implements OAuthRegisteredClientsStore {
  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return loadOAuthStore().clients[clientId];
  }

  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    const store = loadOAuthStore();
    store.clients[client.client_id] = client;
    saveOAuthStore(store);
    return client;
  }
}
