import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Payload } from "../packages/protocol/schema";
import { ATTACHMENT_MISSING_ERROR, Payload as PayloadSchema } from "../packages/protocol/schema";

class FakeRelay {
  readonly room = "attachment-test-room";
  isConnected = true;
  sent: Payload[] = [];
  private listener?: (payload: Payload) => boolean | void | Promise<boolean | void>;
  private keys = new Map<string, string>();
  onMessage(listener: (payload: Payload) => boolean | void | Promise<boolean | void>) {
    this.listener = listener;
    return () => { this.listener = undefined; };
  }
  emit(payload: Payload) { return this.listener?.(payload); }
  async send(payload: Payload) { this.sent.push(payload); }
  setSessionKey(sessionId: string, key: string) { this.keys.set(sessionId, key); }
  async sendSession(payload: Payload) { this.sent.push(payload); }
}

test("an attachment sent ahead of its message is kept until the message names it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-attachment-store-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = join(root, "config");
  t.after(() => {
    if (previous == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
  });
  const { ATTACHMENT_TTL_MS, pruneAttachments, storeAttachment, takeAttachment } =
    await import(`../apps/bridge/src/attachment-store.ts?store=${Date.now()}`);
  const upload = {
    type: "user.attachment" as const, attachmentId: "att-1", name: "photo.png", mimeType: "image/png",
    data: Buffer.from("png-bytes").toString("base64"), createdAt: 1,
  };
  assert.equal(PayloadSchema.parse(upload).type, "user.attachment");
  assert.equal(storeAttachment(upload), true);
  assert.equal(storeAttachment({ ...upload, attachmentId: "../escape" }), false, "an id is a name, never a path");
  assert.equal(takeAttachment("../escape"), undefined);
  const taken = takeAttachment("att-1");
  assert.deepEqual(taken, { name: "photo.png", mimeType: "image/png", data: upload.data });
  assert.equal(takeAttachment("att-1"), undefined, "read exactly once");

  assert.equal(storeAttachment({ ...upload, attachmentId: "att-old" }), true);
  const dir = join(root, "config", "attachments");
  const old = new Date(Date.now() - ATTACHMENT_TTL_MS - 60_000);
  await utimes(join(dir, "att-old.json"), old, old);
  assert.equal(pruneAttachments(), 1, "a stale attachment is dropped");
  assert.deepEqual(await readdir(dir), []);
  await writeFile(join(dir, "att-broken.json"), "not json");
  assert.equal(takeAttachment("att-broken"), undefined);
  await writeFile(join(dir, "att-expired.json"), JSON.stringify({
    name: "a", mimeType: "text/plain", data: "YQ==", receivedAt: Date.now() - ATTACHMENT_TTL_MS - 1,
  }));
  assert.equal(takeAttachment("att-expired"), undefined, "too old to be the message's");
  assert.equal(pruneAttachments(Date.now(), join(root, "nowhere")), 0);
});

test("a message names what came ahead of it, and is rejected when it did not come", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-attachment-monitor-"));
  const repo = join(root, "repo");
  const sessions = join(root, "sessions");
  const session = join(sessions, "project", "grok-att");
  await mkdir(session, { recursive: true });
  await mkdir(repo, { recursive: true });
  await writeFile(join(session, "summary.json"), JSON.stringify({
    info: { id: "grok-att", cwd: repo }, generated_title: "Look at this",
    created_at: Date.now() - 2_000, updated_at: Date.now(), current_model_id: "grok-build",
  }));
  await writeFile(join(session, "chat_history.jsonl"), `${JSON.stringify({
    role: "user", timestamp: Date.now(), content: "Start",
  })}\n`);
  const promptFile = join(root, "prompt.txt");
  const bin = join(root, "grok-fixture");
  await writeFile(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
require("node:fs").writeFileSync(${JSON.stringify(promptFile)}, args[args.indexOf("-p") + 1]);
process.stdout.write(JSON.stringify({ type: "text", data: "seen" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "end", sessionId: "grok-att" }) + "\\n");
`, { mode: 0o755 });
  const env = { ...process.env };
  process.env.GRANTTAP_CONFIG_DIR = join(root, "config");
  process.env.GRANTTAP_GROK_SESSIONS_DIR = sessions;
  process.env.GRANTTAP_GROK_BIN = bin;
  delete process.env.GRANTTAP_ENGINE_ENABLED;
  delete process.env.GRANTTAP_PROJECT_POLICY_ENABLED;
  t.after(() => {
    for (const key of ["GRANTTAP_CONFIG_DIR", "GRANTTAP_GROK_SESSIONS_DIR", "GRANTTAP_GROK_BIN",
      "GRANTTAP_ENGINE_ENABLED", "GRANTTAP_PROJECT_POLICY_ENABLED"]) {
      if (env[key] == null) delete process.env[key];
      else process.env[key] = env[key];
    }
  });
  const { resolveMessageAttachments, startSessionMonitor, sweepAttachments } = await import(`../apps/bridge/src/monitor.ts?att=${Date.now()}`);
  const fake = new FakeRelay();
  const monitor = startSessionMonitor(fake as never);
  t.after(() => monitor.close());
  const receipts = () => fake.sent.filter((item) => item.type === "delivery.receipt") as Array<
    Extract<Payload, { type: "delivery.receipt" }>
  >;

  assert.equal(resolveMessageAttachments({ attachments: [{ name: "a.txt", mimeType: "text/plain", data: "YQ==" }] }).ok, true);
  const missing = resolveMessageAttachments({ attachmentRefs: [{ attachmentId: "nope", name: "gone.png", mimeType: "image/png" }] }, () => undefined);
  assert.deepEqual(missing, { ok: false, missing: "gone.png" });

  assert.equal(await fake.emit({
    type: "user.attachment", attachmentId: "att-photo", name: "screen.png", mimeType: "image/png",
    data: Buffer.from("png").toString("base64"), createdAt: Date.now(),
  }), true);
  assert.equal(await fake.emit({
    type: "user.message", messageId: "m-refs", text: "Look at the screenshot", sessionId: "grok-att",
    attachmentRefs: [{ attachmentId: "att-photo", name: "screen.png", mimeType: "image/png" }], createdAt: Date.now(),
  }), true);
  assert.equal(receipts().at(-1)?.status, "accepted");
  assert.match(await readFile(promptFile, "utf8"), /screen\.png/, "the message reached the agent with its attachment");

  assert.equal(await fake.emit({
    type: "user.message", messageId: "m-missing", text: "And this one", sessionId: "grok-att",
    attachmentRefs: [{ attachmentId: "att-never", name: "never.png", mimeType: "image/png" }], createdAt: Date.now(),
  }), true);
  const rejected = receipts().at(-1)!;
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.error, ATTACHMENT_MISSING_ERROR);
  assert.equal(receipts().filter((receipt) => receipt.messageId === "m-missing").length, 1, "rejected once, never also accepted");

  // The phone sends the same message again, this time with the bytes inside.
  assert.equal(await fake.emit({
    type: "user.message", messageId: "m-missing", text: "And this one", sessionId: "grok-att",
    attachments: [{ name: "never.png", mimeType: "image/png", data: Buffer.from("png2").toString("base64") }], createdAt: Date.now(),
  }), true);
  assert.equal(receipts().at(-1)?.status, "accepted");
  assert.equal(receipts().at(-1)?.messageId, "m-missing");
  assert.match(await readFile(promptFile, "utf8"), /never\.png/);

  // An attachment nobody's message names is swept on the publish loop, a few
  // times an hour, not only when the next one is uploaded.
  const dir = join(root, "config", "attachments");
  await writeFile(join(dir, "att-forgotten.json"), JSON.stringify({ name: "a", mimeType: "text/plain", data: "YQ==", receivedAt: 1 }));
  const stale = new Date(Date.now() - 3 * 60 * 60_000);
  await utimes(join(dir, "att-forgotten.json"), stale, stale);
  const later = Date.now() + 11 * 60_000;
  assert.equal(sweepAttachments(later), 1);
  assert.equal(sweepAttachments(later + 1_000), 0, "not again within the window");
  assert.deepEqual((await readdir(dir)).filter((name) => name === "att-forgotten.json"), []);
});
