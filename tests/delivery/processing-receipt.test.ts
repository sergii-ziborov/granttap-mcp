import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Payload } from "../../packages/protocol/schema";

class ControlledRelay {
  room = "processing-test-room";
  isConnected = true;
  sent: Payload[] = [];
  async send(payload: Payload) { this.sent.push(payload); }
  async sendSession(payload: Payload) { this.sent.push(payload); }
  setSessionKey() {}
}

test("a slow provider is acknowledged before its result and duplicate delivery stays leased", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-processing-receipt-"));
  const sessionId = "grok-processing-fixture";
  const folder = join(root, "sessions", "project", sessionId);
  const repo = join(root, "repo"), released = join(root, "released"), invoked = join(root, "invoked");
  await mkdir(folder, { recursive: true });
  await mkdir(repo);
  await writeFile(join(folder, "summary.json"), JSON.stringify({
    info: { id: sessionId, cwd: repo }, generated_title: "Delivery fixture",
    created_at: Date.now() - 2000, updated_at: Date.now(), current_model_id: "grok-build",
  }));
  await writeFile(join(folder, "chat_history.jsonl"), JSON.stringify({
    role: "user", timestamp: Date.now(), content: "Fixture request",
  }) + "\n");
  const bin = join(root, "fixture-provider");
  await writeFile(bin, `#!/usr/bin/env node
const fs=require('node:fs');
fs.appendFileSync(${JSON.stringify(invoked)}, 'one\\n');
const poll=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(released)}))return;
clearInterval(poll);process.stdout.write(JSON.stringify({type:'text',data:'Fixture complete'})+'\\n');
process.stdout.write(JSON.stringify({type:'end',sessionId:${JSON.stringify(sessionId)}})+'\\n');},20);
`, { mode: 0o755 });
  const previous = { ...process.env };
  Object.assign(process.env, { GRANTTAP_CONFIG_DIR: join(root, "config"),
    GRANTTAP_GROK_SESSIONS_DIR: join(root, "sessions"), GRANTTAP_GROK_BIN: bin });
  delete process.env.GRANTTAP_ENGINE_ENABLED;
  delete process.env.GRANTTAP_PROJECT_POLICY_ENABLED;
  t.after(async () => {
    await writeFile(released, "release");
    for (const key of ["GRANTTAP_CONFIG_DIR", "GRANTTAP_GROK_SESSIONS_DIR", "GRANTTAP_GROK_BIN",
      "GRANTTAP_ENGINE_ENABLED", "GRANTTAP_PROJECT_POLICY_ENABLED"]) {
      if (previous[key] == null) delete process.env[key]; else process.env[key] = previous[key];
    }
  });
  const { handleMonitorMessage } = await import("../../apps/bridge/src/monitor/handlers/inbound");
  const { beginDelivery } = await import("../../apps/bridge/src/delivery");
  const relay = new ControlledRelay();
  const message = { type: "user.message" as const, messageId: "slow-fixture", sessionId,
    agent: "grok" as const, text: "Continue fixture", createdAt: Date.now() };
  const context = { leadership: { acquire: () => true }, subscriptions: new Set<string>(),
    publish: async () => {} };
  let finished = false;
  const first = handleMonitorMessage(relay as never, message, context).finally(() => { finished=true; });
  try {
    for (let n=0;n<100;n++) {
      try { await access(invoked); break; } catch { await new Promise(r=>setTimeout(r,20)); }
    }
    assert.equal(finished, false, "provider still waits for its controlled result");
    assert(relay.sent.some(p=>p.type==='delivery.receipt' && p.messageId===message.messageId && p.status==='accepted'),
      "phone must receive the processing receipt before provider finishes");
    assert.equal(await handleMonitorMessage(relay as never,message,context),true);
    assert.equal(beginDelivery(message.messageId,Date.now()+9*60_000),'processing',
      'lease must cover the ten-minute provider timeout');
    assert.equal(relay.sent.filter(p=>p.type==='delivery.receipt').length,2);
  } finally { await writeFile(released,'release'); await first; }
  assert.equal((await readFile(invoked,'utf8')).trim().split('\n').length,1,
    'duplicate transport delivery must not invoke the provider twice');
  assert(relay.sent.some(p=>p.type==='agent.event' && p.originMessageId===message.messageId && p.kind==='response'));
});
