import assert from "node:assert/strict";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Payload } from "../packages/protocol/schema";

class FakeRelay {
  readonly room = "monitor-edges";
  isConnected = false;
  sent: Payload[] = [];
  sessionSent: Payload[] = [];
  listener?: (payload: Payload) => boolean | void | Promise<boolean | void>;
  onMessage(listener: (payload: Payload) => boolean | void | Promise<boolean | void>) {
    this.listener = listener;
    return () => { this.listener = undefined; };
  }
  emit(payload: Payload) { return this.listener?.(payload); }
  setSessionKey() {}
  async send(payload: Payload) { this.sent.push(payload); }
  async sendSession(payload: Payload) { this.sessionSent.push(payload); }
}

function restore(t: test.TestContext, values: Record<string, string>): void {
  const prior = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    prior.set(key, process.env[key]);
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of prior) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

async function fixture(root: string): Promise<Record<string, string>> {
  const claude = join(root, "claude", "project");
  const codex = join(root, "codex", "2026", "08", "23");
  const grok = join(root, "grok", "project", "grok-existing");
  await Promise.all([mkdir(claude, { recursive: true }), mkdir(codex, { recursive: true }), mkdir(grok, { recursive: true })]);
  const old = Date.now() - 180_000;
  const claudePath = join(claude, "claude-idle.jsonl");
  await writeFile(claudePath, `${JSON.stringify({ sessionId: "claude-idle", cwd: root,
    timestamp: old, type: "user", message: { role: "user", content: "Claude task" } })}\n`);
  const codexRows = (id: string) => [
    { timestamp: old, type: "session_meta", payload: { id, cwd: root } },
    { timestamp: old + 1, type: "event_msg", payload: { type: "user_message", message: id } },
  ].map((row) => JSON.stringify(row)).join("\n");
  const codexOk = join(codex, "rollout-ok.jsonl");
  const codexFail = join(codex, "rollout-fail.jsonl");
  const codexWorking = join(codex, "rollout-working.jsonl");
  await Promise.all([
    writeFile(codexOk, `${codexRows("codex-ok")}\n`),
    writeFile(codexFail, `${codexRows("codex-fail")}\n`),
    writeFile(codexWorking, `${codexRows("codex-working")}\n`),
    writeFile(join(grok, "summary.json"), JSON.stringify({ info: { id: "grok-existing", cwd: root },
      generated_title: "Grok", created_at: old, updated_at: old, current_model_id: "grok-build" })),
    writeFile(join(grok, "chat_history.jsonl"), `${JSON.stringify({ role: "user", timestamp: old, content: "Grok task" })}\n`),
  ]);
  const date = new Date(old);
  await Promise.all([utimes(claudePath, date, date), utimes(codexOk, date, date), utimes(codexFail, date, date)]);
  const codexBin = join(root, "codex.mjs");
  await writeFile(codexBin, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const readline=createInterface({input:process.stdin}); let thread='';
readline.on('line', line => { const m=JSON.parse(line); if(m.id===1) process.stdout.write(JSON.stringify({id:1,result:{}})+'\\n');
else if(m.id===2){ thread=m.params.threadId; process.stdout.write(JSON.stringify({id:2,result:{}})+'\\n'); }
else if(m.id===3){ if(thread.includes('fail')) process.stdout.write(JSON.stringify({id:3,error:{message:'compact denied'}})+'\\n');
else process.stdout.write(JSON.stringify({method:'item/completed',params:{item:{type:'contextCompaction'}}})+'\\n'); } });
`, { mode: 0o755 });
  const grokBin = join(root, "grok.mjs");
  await writeFile(grokBin, `#!/usr/bin/env node
const args=process.argv.slice(2); const prompt=args[args.indexOf('-p')+1] || ''; if(prompt.includes('fail')) { process.stderr.write('failed'); process.exit(7); }
setTimeout(()=>{ const at=args.indexOf('--resume'); const id=at>=0?args[at+1]:'new-grok';
process.stdout.write(JSON.stringify({type:'text',data:'done'})+'\\n'+JSON.stringify({type:'end',sessionId:id})+'\\n'); },80);
`, { mode: 0o755 });
  return { claude: join(root, "claude"), codex: join(root, "codex"), grok: join(root, "grok"), codexBin, grokBin };
}

test("monitor compaction, delivery dedupe, failures, and leadership remain bounded", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-monitor-edges-"));
  const paths = await fixture(root);
  restore(t, {
    GRANTTAP_CONFIG_DIR: join(root, "config"),
    GRANTTAP_CLAUDE_PROJECTS_DIR: paths.claude!,
    GRANTTAP_CODEX_SESSIONS_DIR: paths.codex!,
    GRANTTAP_GROK_SESSIONS_DIR: paths.grok!,
    GRANTTAP_CODEX_BIN: paths.codexBin!,
    GRANTTAP_GROK_BIN: paths.grokBin!,
  });
  const monitorModule = await import(`../apps/bridge/src/monitor.ts?edges=${Date.now()}`);
  const firstRelay = new FakeRelay();
  const secondRelay = new FakeRelay();
  const first = monitorModule.startSessionMonitor(firstRelay as never);
  const second = monitorModule.startSessionMonitor(secondRelay as never);
  t.after(() => { second.close(); first.close(); });

  const compact = (sessionId: string): Payload => ({
    type: "session.compact", sessionId, createdAt: Date.now(),
  });
  assert.equal(await firstRelay.emit(compact("claude-idle")), true);
  assert.match(JSON.stringify(firstRelay.sessionSent.at(-1)), /does not expose/);
  assert.equal(await firstRelay.emit(compact("codex-working")), true);
  assert.match(JSON.stringify(firstRelay.sessionSent.at(-1)), /active Codex turn/);
  assert.equal(await firstRelay.emit(compact("codex-fail")), true);
  assert.match(JSON.stringify(firstRelay.sessionSent.at(-1)), /compact denied/);
  assert.equal(await firstRelay.emit(compact("codex-ok")), true);
  assert.match(JSON.stringify(firstRelay.sessionSent.at(-1)), /completed/);

  const message = (messageId: string, text: string): Payload => ({
    type: "user.message", messageId, sessionId: "grok-existing", text, createdAt: Date.now(),
  });
  const pending = firstRelay.emit(message("dedupe", "slow"));
  assert.equal(await firstRelay.emit(message("dedupe", "slow")), false);
  assert.equal(await pending, true);
  assert.equal(await firstRelay.emit(message("dedupe", "slow")), true);
  assert.equal(await firstRelay.emit(message("existing-fail", "fail")), true);
  assert.equal(firstRelay.sessionSent.some((item) => /Could not deliver/.test(JSON.stringify(item))), true);
  assert.equal(await firstRelay.emit({
    type: "user.message", messageId: "new-fail", agent: "grok", cwd: root,
    text: "fail", createdAt: Date.now(),
  }), true);
  assert.equal(firstRelay.sent.some((item) => /Could not create/.test(JSON.stringify(item))), true);

  await first.publish();
  await second.publish();
  assert.equal(secondRelay.sent.length, 0, "only one monitor owns phone routing");
});
