import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayClient } from "../../../../../../packages/core/relay-client";
import type { Payload, SessionInfo } from "../../../../../../packages/protocol/schema";
import { inspectRepositoryAsync } from "../../catalog/repository-inspection";
import { MeshStore } from "../../store";
import type { RepositoryRequestDependencies } from "..";

export const now = 1_800_000_000_000;

export type Sent = { payload: Payload; via: "project" | "pairing"; peer?: string; reliable?: boolean };

/** A relay that records what reached the phone, and under which layer. */
export function fakeRelay(room = "paired-room") {
  const sent: Sent[] = [];
  const grants: Array<{ sessionId: string; peer?: string }> = [];
  const client = {
    room,
    setSessionKey() {},
    async send(payload: Payload, _to: unknown, options: { peerPublicKey?: string } = {}) {
      if (payload.type === "session.key.grant") grants.push({ sessionId: payload.sessionId, peer: options.peerPublicKey });
    },
    async sendSession(payload: Payload, _sessionId: string, _to: unknown,
      options: { peerPublicKey?: string; reliable?: boolean } = {}) {
      sent.push({ payload, via: "project", peer: options.peerPublicKey, reliable: options.reliable });
    },
    async sendToPeer(payload: Payload, peer: string) {
      sent.push({ payload, via: "pairing", peer });
    },
  };
  return { client: client as unknown as RelayClient, sent, grants };
}

export function project(projectId: string, name = `Mesh ${projectId}`) {
  return { projectId, name, canonicalRepositoryId: `github.com/example/${projectId}`, createdAt: now };
}

export function freshStore(): MeshStore {
  return new MeshStore(join(mkdtempSync(join(tmpdir(), "granttap-repository-edit-")), "mesh.json"), () => now);
}

/** A committed checkout, optionally with an origin, and a folder inside it. */
export function gitRepository(name = "app", origin?: string): { root: string; inner: string } {
  const root = join(realpathSync(mkdtempSync(join(tmpdir(), "granttap-repository-"))), name);
  mkdirSync(join(root, "src"), { recursive: true });
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, "src", "index.ts"), "export {};\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "base"]);
  if (origin) execFileSync("git", ["-C", root, "remote", "add", "origin", origin]);
  return { root, inner: join(root, "src") };
}

export function chat(sessionId: string, cwd: string, lastActivityAt = now): SessionInfo {
  return { sessionId, agent: "codex", cwd, state: "idle", startedAt: now - 1_000, lastActivityAt,
    tokensSession: 0, tokensLastTurn: 0 };
}

export function dependencies(store: MeshStore, overrides: Partial<RepositoryRequestDependencies> = {}) {
  const lines: string[] = [];
  const sessions: SessionInfo[] = [];
  const deps: RepositoryRequestDependencies = {
    store: () => store, endpoint: () => "mac", meshEnabled: () => true,
    paired: (room, peer) => room === "paired-room" && peer === "phone",
    sessions: () => sessions, inspect: inspectRepositoryAsync, now: () => now,
    log: (line) => { lines.push(line); }, ...overrides,
  };
  return { deps, lines, sessions };
}
