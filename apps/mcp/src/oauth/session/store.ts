import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { configDir } from "../../../../bridge/src/config";
import { writePrivateFile } from "../../../../bridge/src/config/access/write-private";

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
  writePrivateFile(storePath(), JSON.stringify(store, null, 2) + "\n");
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
