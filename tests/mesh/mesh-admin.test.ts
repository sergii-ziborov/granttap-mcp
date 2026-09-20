/**
 * What the person may do to the mesh that no agent may: release a claim that
 * is not theirs by ownership, with the Project checked and the act written
 * down; and what the staging area for attachments refuses to hold.
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Payload } from "../../packages/protocol/schema";
import { Payload as PayloadSchema } from "../../packages/protocol/schema";
import { saveRuntimeConfig } from "../../apps/bridge/src/config";
import { releaseClaimByPerson } from "../../apps/bridge/src/mesh/admin";
import { localMeshStore, resetLocalMeshStore } from "../../apps/bridge/src/mesh/local-remote/local";
import { MeshStore } from "../../apps/bridge/src/mesh/store";
import { argumentsDigest, OperationLedger, type OperationRecord } from "../../apps/mcp/src/mcp-tools/operation-ledger";

const now = 1_800_000_000_000;

function project(projectId: string) {
  return {
    projectId, name: `Project ${projectId}`, repositoryRoot: `/repo/${projectId}`,
    canonicalRepositoryId: `github.com/example/${projectId}`, createdAt: now,
  };
}

function task(projectId: string, taskId: string) {
  return {
    taskId, projectId, title: "Pairing", goal: "Finish pairing", state: "working" as const,
    ownerSessionId: `chat-${taskId}`, createdAt: now, updatedAt: now,
  };
}

function claim(projectId: string, taskId: string, claimId: string) {
  return {
    claimId, projectId, taskId, ownerSessionId: `chat-${taskId}`, resource: "src/auth/**",
    mode: "claim" as const, createdAt: now, expiresAt: now + 600_000,
  };
}

function release(projectId: string, claimId: string, reason?: string) {
  return {
    type: "mesh.claim.release" as const, sessionId: projectId, projectId, claimId,
    ...(reason ? { reason } : {}), createdAt: now,
  };
}

class FakeRelay {
  readonly room = "admin-test-room";
  isConnected = true;
  sent: Payload[] = [];
  private listener?: (payload: Payload) => boolean | void | Promise<boolean | void>;
  onMessage(listener: (payload: Payload) => boolean | void | Promise<boolean | void>) {
    this.listener = listener;
    return () => { this.listener = undefined; };
  }
  emit(payload: Payload) { return this.listener?.(payload); }
  async send(payload: Payload) { this.sent.push(payload); }
  setSessionKey() {}
  async sendSession(payload: Payload) { this.sent.push(payload); }
}

test("the person releases a claim by their own authority, inside its Project, and it is written down", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-admin-release-"));
  const store = new MeshStore(join(root, "mesh.json"), () => now);
  store.upsertProject(project("alpha"));
  store.upsertProject(project("beta"));
  store.upsertTask(task("alpha", "a1"));
  store.upsertTask(task("beta", "b1"));
  store.claim(claim("alpha", "a1", "held-by-a-dead-agent"));
  store.claim(claim("beta", "b1", "elsewhere"));
  const lines: string[] = [];
  const log = (line: string) => { lines.push(line); };

  assert.deepEqual(releaseClaimByPerson(store, release("alpha", "nope"), log), { released: false, reason: "unknown_claim" });
  // A claim id is not a secret: the person of one Project does not reach into another with it.
  assert.deepEqual(releaseClaimByPerson(store, release("alpha", "elsewhere"), log), { released: false, reason: "other_project" });
  assert.equal(store.snapshot("beta")?.claims.length, 1);
  const outcome = releaseClaimByPerson(store, release("alpha", "held-by-a-dead-agent", "the agent is gone"), log);
  assert.equal(outcome.released, true);
  assert.equal(store.snapshot("alpha")?.claims.length, 0, "released, whoever owned it");
  assert.match(lines.at(-1) ?? "", /held-by-a-dead-agent on src\/auth\/\*\* held by chat-a1 released by the person: the agent is gone/);
  assert.match(lines[0] ?? "", /refused: no such claim/);
  assert.match(lines[1] ?? "", /refused: not in this Project/);
  // Twice is once: the second release finds nothing, and says so.
  assert.deepEqual(releaseClaimByPerson(store, release("alpha", "held-by-a-dead-agent"), log), { released: false, reason: "unknown_claim" });
});

test("the release is a message of its own on the wire, and the monitor applies it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-admin-monitor-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = join(root, "config");
  resetLocalMeshStore();
  t.after(() => {
    resetLocalMeshStore();
    if (previous == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
  });
  saveRuntimeConfig({ meshEnabled: true });
  const parsed = PayloadSchema.parse(release("alpha", "c-1", "stuck"));
  assert.equal(parsed.type, "mesh.claim.release");
  assert.equal(PayloadSchema.safeParse({ ...release("alpha", "c-1"), sessionId: "other" }).success, false, "project-scoped, like every Project message");
  const store = localMeshStore();
  store.upsertProject(project("alpha"));
  store.upsertTask(task("alpha", "a1"));
  store.claim(claim("alpha", "a1", "c-1"));
  const { startSessionMonitor } = await import(`../../apps/bridge/src/monitor/index.ts?admin=${Date.now()}`);
  const fake = new FakeRelay();
  const monitor = startSessionMonitor(fake as never);
  t.after(() => monitor.close());
  assert.equal(await fake.emit(parsed), true);
  assert.equal(localMeshStore().snapshot("alpha")?.claims.length, 0, "the claim is gone on this computer");
  const results = () => fake.sent.filter((item) => item.type === "mesh.claim.release.result") as Array<
    Extract<Payload, { type: "mesh.claim.release.result" }>
  >;
  assert.equal(results().length, 1, "the phone that asked is answered");
  assert.deepEqual(
    { ok: results()[0]!.ok, claimId: results()[0]!.claimId, projectId: results()[0]!.projectId, reason: results()[0]!.reason },
    { ok: true, claimId: "c-1", projectId: "alpha", reason: undefined },
  );
  assert.equal(await fake.emit(PayloadSchema.parse(release("alpha", "c-1", "again"))), true, "handled, though there was nothing left to release");
  assert.equal(results().length, 2);
  assert.equal(results()[1]!.ok, false);
  assert.equal(results()[1]!.reason, "unknown_claim");
  assert.match(results()[1]!.detail ?? "", /already be gone/);
  assert.equal(PayloadSchema.safeParse({ ...results()[1]!, ok: false, reason: undefined }).success, false, "a refusal says why");
  saveRuntimeConfig({ meshEnabled: false });
  assert.equal(await fake.emit(PayloadSchema.parse(release("alpha", "c-1"))), false, "with the Mesh off, the message is not this computer's to handle");
});

test("the staging area for attachments holds only so many, and the oldest make room", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-attachment-quota-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = join(root, "config");
  t.after(() => {
    if (previous == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
  });
  const { MAX_STAGED_ATTACHMENTS, MAX_STAGED_BYTES, storeAttachment, takeAttachment } =
    await import(`../../apps/bridge/src/delivery/attachment-store.ts?quota=${Date.now()}`);
  // The clock is the real one: what is stale is judged by the files' own times.
  const clock = Date.now();
  const upload = (id: string, data = "YQ==") => ({
    type: "user.attachment" as const, attachmentId: id, name: `${id}.txt`, mimeType: "text/plain", data, createdAt: clock,
  });
  for (let index = 0; index < MAX_STAGED_ATTACHMENTS + 3; index += 1) {
    assert.equal(storeAttachment(upload(`att-${String(index).padStart(3, "0")}`), "room", clock + index), true);
  }
  const dir = join(root, "config", "attachments");
  const names = (await readdir(dir)).sort();
  assert.equal(names.length, MAX_STAGED_ATTACHMENTS, "never more than the staging area holds");
  assert.equal(names[0], "att-003.json", "the oldest three made room");
  assert.equal(takeAttachment("att-000", "room", clock)?.name, undefined, "gone: the phone sends it inline when its message comes");
  assert.equal(takeAttachment("att-034", "room", clock)?.name, "att-034.txt");
  // One attachment larger than the whole area is refused outright, and the rest are untouched.
  assert.equal(storeAttachment(upload("att-huge", "x".repeat(MAX_STAGED_BYTES + 1)), "room", clock), false);
  assert.equal((await readdir(dir)).length, MAX_STAGED_ATTACHMENTS - 1);
});

test("a ledger recalls what a named call did, for its caller and its arguments, one call at a time", async () => {
  const ledger = new OperationLedger(1_000);
  const digest = argumentsDigest({ question: "Deploy?" });
  assert.equal(ledger.recall("chat-a", "ask", "op-1", digest, now).kind, "new");
  ledger.remember("chat-a", "ask", "op-1", { tool: "ask", digest, text: "yes", outcome: { decision: "yes" } }, now);
  const recalled = ledger.recall("chat-a", "ask", "op-1", digest, now + 500);
  assert.equal(recalled.kind, "replay");
  assert.equal(recalled.kind === "replay" ? recalled.record.text : "", "yes");
  // Another caller's name is another name; another question under the same name is a conflict.
  assert.equal(ledger.recall("chat-b", "ask", "op-1", digest, now + 500).kind, "new", "one chat's answer is never another's");
  assert.equal(ledger.recall("chat-a", "ask_yes_no", "op-1", digest, now + 500).kind, "new", "one tool's name is not another's");
  assert.equal(ledger.recall("chat-a", "ask", "op-1", argumentsDigest({ question: "Publish?" }), now + 500).kind, "conflict");
  assert.equal(ledger.recall("chat-a", "ask", "op-1", digest, now + 1_001).kind, "new", "forgotten after its time");
  assert.equal(argumentsDigest({ question: " Deploy? " }), digest, "whitespace is not an argument");
  assert.equal(argumentsDigest({ question: "Deploy?", operationId: undefined }), digest, "an absent field is no field");
  // Two retries at once are one call: the second waits for the first's answer.
  let asked = 0;
  let release: (record: OperationRecord) => void = () => {};
  const first = ledger.run("chat-a", "ask", "op-2", () => new Promise<OperationRecord>((resolve) => {
    asked += 1;
    release = resolve;
  }), () => now + 2_000);
  const waiting = ledger.recall("chat-a", "ask", "op-2", digest, now + 2_000);
  assert.equal(waiting.kind, "in_flight");
  release({ at: now + 2_000, tool: "ask", digest, text: "no", outcome: { decision: "no" } });
  assert.equal((await first).text, "no");
  assert.equal(asked, 1);
  assert.equal(ledger.recall("chat-a", "ask", "op-2", digest, now + 2_000).kind, "replay", "kept once it settled");
  for (let index = 0; index < 70; index += 1) {
    ledger.remember("chat-a", "notify", `op-${index}`, { tool: "notify", digest, text: "", outcome: {} }, now + 3_000);
  }
  assert.equal(ledger.recall("chat-a", "notify", "op-0", digest, now + 3_000).kind, "new", "the oldest gave way");
  assert.equal(ledger.recall("chat-a", "notify", "op-69", digest, now + 3_000).kind, "replay");
});
