import type { McpServerInfo } from "../../../../packages/protocol/schema";

export type CodexMcpRow = {
  name?: unknown;
  enabled?: unknown;
  auth_status?: unknown;
  transport?: unknown;
};

export type McpTransportConfig = {
  type?: unknown;
  command?: unknown;
  args?: unknown;
  env?: unknown;
  env_vars?: unknown;
  cwd?: unknown;
  url?: unknown;
  bearer_token_env_var?: unknown;
  http_headers?: unknown;
  env_http_headers?: unknown;
  headers?: unknown;
};

export type McpDescriptor = {
  name: string;
  configuredEnabled: boolean;
  authStatus?: string;
  transport?: McpTransportConfig;
};

export type ServerMetadata = Pick<
  McpServerInfo,
  "title" | "websiteUrl" | "version" | "icons" | "metadataSource"
>;
