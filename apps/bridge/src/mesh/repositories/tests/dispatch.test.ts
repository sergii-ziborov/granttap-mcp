/**
 * The repository messages on the wire, through the monitor that receives
 * them: a paired phone lists this computer's checkouts, adds one to a Mesh
 * and takes it out again, and is answered each time.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { MeshRepositoryEditResult, MeshRepositoryList, Payload } from "../../../../../../packages/protocol/schema";
import { Payload as PayloadSchema } from "../../../../../../packages/protocol/schema";
import { saveRuntimeConfig } from "../../../config";
import { resetComputerIdentity } from "../../identity/computer";
import { localMeshStore, resetLocalMeshStore } from "../../local-remote/local";
import { gitRepository, project } from "./support";

class FakeRelay {
  readonly room = "repository-room";
  isConnected = true;
  sent: Array<{ payload: Payload; peer?: string }> = [];
  private listener?: (payload: Payload, peer: string) => boolean | void | Promise<boolean | void>;
  onMessage(listener: (payload: Payload, peer: string) => boolean | void | Promise<boolean | void>) {
    this.listener = listener;
    return () => { this.listener = undefined; };
  }
  emit(payload: unknown, peer: string) { return this.listener?.(PayloadSchema.parse(payload), peer); }
  async send(payload: Payload, _to?: unknown, options: { peerPublicKey?: string } = {}) {
    this.sent.push({ payload, peer: options.peerPublicKey });
  }
  setSessionKey() {}
  async sendSession(payload: Payload, _sessionId: string, _to?: unknown, options: { peerPublicKey?: string } = {}) {
    this.sent.push({ payload, peer: options.peerPublicKey });
  }
  async sendToPeer(payload: Payload, peer: string) { this.sent.push({ payload, peer }); }
  answers<T extends Payload["type"]>(type: T) {
    return this.sent.filter((item) => item.payload.type === type) as Array<{ payload: Extract<Payload, { type: T }>; peer?: string }>;
  }
}

test("a paired phone lists, adds and removes this computer's repositories of a Mesh", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "granttap-repository-dispatch-"));
  const config = join(root, "config");
  mkdirSync(config, { recursive: true });
  const previous = { config: process.env.GRANTTAP_CONFIG_DIR, computer: process.env.GRANTTAP_COMPUTER_ID };
  process.env.GRANTTAP_CONFIG_DIR = config;
  process.env.GRANTTAP_COMPUTER_ID = "studio";
  resetLocalMeshStore();
  resetComputerIdentity();
  t.after(() => {
    resetLocalMeshStore();
    resetComputerIdentity();
    for (const [key, value] of [["GRANTTAP_CONFIG_DIR", previous.config], ["GRANTTAP_COMPUTER_ID", previous.computer]] as const) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });
  writeFileSync(join(config, "machine.json"), JSON.stringify({ room: "repository-room", role: "machine", peerPublicKey: "phone-key" }));
  saveRuntimeConfig({ meshEnabled: true });
  const store = localMeshStore();
  store.upsertProject(project("alpha", "Frontend"));
  store.upsertBinding({ bindingId: "binding-workstation", projectId: "alpha", endpointId: "workstation",
    repositoryId: "github.com/example/api", displayName: "api", available: true });
  const { root: checkout } = gitRepository("web");
  const { startSessionMonitor } = await import(`../../../monitor/index.ts?repositories=${Date.now()}`);
  const fake = new FakeRelay();
  const monitor = startSessionMonitor(fake as never);
  t.after(() => monitor.close());
  const createdAt = Date.now();
  const scope = { sessionId: "alpha", projectId: "alpha", createdAt };

  assert.equal(await fake.emit({ type: "mesh.repository.edit", ...scope, requestId: "add-1", action: "add", path: checkout }, "phone-key"), true);
  const added = fake.answers("mesh.repository.edit.result")[0];
  assert.deepEqual([added?.payload.ok, added?.peer], [true, "phone-key"], "the phone that asked is answered");
  const bindingId = added?.payload.bindingId;
  assert.equal(localMeshStore().snapshot("alpha")?.bindings?.find((item) => item.bindingId === bindingId)?.endpointId, "studio");

  assert.equal(await fake.emit({ type: "mesh.repository.query", ...scope, requestId: "list-1" }, "phone-key"), true);
  const list = fake.answers("mesh.repository.list")[0]?.payload as MeshRepositoryList;
  assert.equal(list.computerId, "studio");
  assert.deepEqual(list.repositories.map((item) => [item.path, item.boundHere, item.bindingId]), [[checkout, true, bindingId]]);

  assert.equal(await fake.emit({ type: "mesh.repository.edit", ...scope, requestId: "remove-1", action: "remove", bindingId }, "phone-key"), true);
  const removed = fake.answers("mesh.repository.edit.result")[1]?.payload as MeshRepositoryEditResult;
  assert.deepEqual([removed.ok, removed.action, removed.bindingId], [true, "remove", bindingId]);
  assert.deepEqual(localMeshStore().snapshot("alpha")?.bindings?.map((item) => item.bindingId), ["binding-workstation"]);
  assert.equal(localMeshStore().bindingRemoved("alpha", "studio", list.repositories[0]!.repositoryId), true);

  assert.equal(await fake.emit({ type: "mesh.repository.query", ...scope, requestId: "list-2" }, "someone-else"), false,
    "a controller this computer was not paired with is not answered");
  assert.equal(PayloadSchema.safeParse({ type: "mesh.repository.query", ...scope, sessionId: "beta", requestId: "x" }).success, false);
  saveRuntimeConfig({ meshEnabled: false });
  assert.equal(await fake.emit({ type: "mesh.repository.query", ...scope, requestId: "list-3" }, "phone-key"), false);
  assert.equal(await fake.emit({ type: "mesh.repository.edit", ...scope, requestId: "add-2", action: "add", path: checkout }, "phone-key"), true);
  assert.equal(fake.answers("mesh.repository.edit.result")[2]?.payload.reason, "mesh-disabled");
});
