import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RelayClient } from "../../../../../../packages/core/relay-client";
import type { Payload } from "../../../../../../packages/protocol/schema";
import { createPairing, machineConfigPath, saveConfig, saveRuntimeConfig } from "../../../../../bridge/src/config";
import { localMeshStore, resetLocalMeshStore } from "../../../../../bridge/src/mesh/local-remote/local";
import { connectInMemory } from "../../../../../../tests/support/mcp-client";
import { forwardingRelay } from "../../../../../../tests/support/forwarding-relay";
import { resetRelay } from "../../connect/relay";
import { registerSignInTool } from "../index";
import { unusedLoopbackPort } from "./loopback-port";

export type SignInRequestSeen = Extract<Payload, { type: "signin.request" }>;

function isolate(t: TestContext, root: string): void {
  // The fixture's chats are the chats: an id inherited from the shell must not speak for them.
  delete process.env.CLAUDE_CODE_SESSION_ID;
  process.env.GRANTTAP_CONFIG_DIR = root;
  resetRelay();
  resetLocalMeshStore();
  t.after(() => {
    resetRelay();
    resetLocalMeshStore();
    delete process.env.GRANTTAP_CONFIG_DIR;
  });
}

function signInServer(timeoutMs?: number): McpServer {
  const server = new McpServer({ name: "sign-in-fixture", version: "1" });
  registerSignInTool(server, { timeoutMs });
  return server;
}

/** A live Claude chat on this computer, so an attributed call has a chat to belong to. */
function seedChat(): void {
  const now = Date.now();
  const store = localMeshStore();
  store.upsertProject({
    projectId: "project", name: "GrantTap", repositoryRoot: "/repo",
    canonicalRepositoryId: "github.com/example/granttap", createdAt: now,
  });
  store.upsertTask({
    taskId: "task", projectId: "project", title: "Deploy", goal: "Ship the worker", state: "working",
    ownerSessionId: "claude-session", createdAt: now, updatedAt: now,
  });
  store.linkExecution({
    taskId: "task", sessionId: "claude-session", provider: "claude", computerId: "MacBook",
    workspace: "/repo", branch: "claude/deploy", startedAt: now,
  });
}

/** The command's own loopback listener: what `wrangler login` runs while it waits. */
async function commandListener(t: TestContext, answerAfterMs: number) {
  const seen: Array<{ method?: string; url?: string }> = [];
  const server = createServer((request, response) => {
    seen.push({ method: request.method, url: request.url });
    setTimeout(() => {
      response.writeHead(200, { "set-cookie": "session=page-with-token" });
      response.end("page-with-token");
    }, answerAfterMs);
  });
  // Once this listener stops, a replay must find nothing at either loopback address, not another program.
  const port = await unusedLoopbackPort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  let stopped = false;
  const stop = () => new Promise<void>((resolve) => {
    if (stopped) { resolve(); return; }
    stopped = true;
    server.closeAllConnections();
    server.close(() => resolve());
  });
  t.after(stop);
  return { port, seen, stop };
}

export async function pairedSignIn(t: TestContext, options: { timeoutMs?: number; commandAnswersAfterMs?: number } = {}) {
  const timeoutMs = options.timeoutMs ?? 5_000;
  isolate(t, await mkdtemp(join(tmpdir(), "granttap-sign-in-")));
  const relay = await forwardingRelay();
  t.after(() => relay.close());
  const paired = createPairing(relay.url);
  saveConfig(machineConfigPath(), paired.machineCfg);
  saveRuntimeConfig({ meshEnabled: true });
  seedChat();

  const requests: SignInRequestSeen[] = [];
  let answer: (request: SignInRequestSeen) => Promise<void> = async () => {};
  const phone = new RelayClient(paired.phoneCfg);
  phone.onMessage(async (payload) => {
    if (payload.type === "signin.request") {
      requests.push(payload);
      await answer(payload);
    }
    return true;
  });
  await phone.connect();
  t.after(() => phone.close());

  const cli = await commandListener(t, options.commandAnswersAfterMs ?? 0);
  const client = await connectInMemory(signInServer(timeoutMs));
  t.after(() => client.close());
  return {
    phone, requests, cli, client, timeoutMs,
    onRequest: (handler: typeof answer) => { answer = handler; },
    call: (args: Record<string, unknown>) => client.callTool({ name: "request_sign_in", arguments: args }),
  };
}

export async function unpairedSignIn(t: TestContext): Promise<Client> {
  isolate(t, await mkdtemp(join(tmpdir(), "granttap-sign-in-unpaired-")));
  const client = await connectInMemory(signInServer());
  t.after(() => client.close());
  return client;
}
