import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type {
  PeerConfig,
  SendOptions,
} from "../../../packages/core/relay-client";
import type {
  Payload,
  Role,
} from "../../../packages/protocol/schema";

type Listener = (payload: Payload) => boolean | void | Promise<boolean | void>;

class FakeRelayClient {
  readonly sent: Array<{
    payload: Payload;
    to: Role | "all";
    options: SendOptions;
    sessionId?: string;
  }> = [];
  private readonly listeners = new Set<Listener>();

  async send(
    payload: Payload,
    to: Role | "all" = "phone",
    options: SendOptions = {},
  ): Promise<void> {
    this.sent.push({ payload, to, options });
  }

  async sendSession(
    payload: Payload,
    sessionId: string,
    to: Role | "all" = "phone",
    options: SendOptions = {},
  ): Promise<void> {
    this.sent.push({ payload, to, options, sessionId });
  }

  setSessionKey(): void {}

  onMessage(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  waitFor<T extends Payload>(
    predicate: (payload: Payload) => payload is T,
    timeoutMs: number,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error("waitFor timeout"));
      }, timeoutMs);
      const off = this.onMessage((payload) => {
        if (!predicate(payload)) return false;
        clearTimeout(timer);
        off();
        resolve(payload);
        return true;
      });
    });
  }

  async emit(payload: Payload): Promise<boolean> {
    const results = await Promise.all(
      [...this.listeners].map(async (listener) => (await listener(payload)) === true),
    );
    return results.some(Boolean);
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true, "condition was not reached before timeout");
}

const previousConfigDir = process.env.GRANTTAP_CONFIG_DIR;

const testConfigDir = mkdtempSync(join(tmpdir(), "granttap-mcp-approval-"));

process.env.GRANTTAP_CONFIG_DIR = testConfigDir;

after(() => {
  if (previousConfigDir == null) delete process.env.GRANTTAP_CONFIG_DIR;
  else process.env.GRANTTAP_CONFIG_DIR = previousConfigDir;
  rmSync(testConfigDir, { recursive: true, force: true });
});

const cfg: PeerConfig = {
  relayUrl: "ws://127.0.0.1:1",
  room: "approval-test-room",
  role: "machine",
  deviceName: "test-machine",
  senderId: "test-machine-1",
  myPublicKey: "unused",
  mySecretKey: "unused",
  peerPublicKey: "unused",
};

export { FakeRelayClient, waitUntil, cfg };
