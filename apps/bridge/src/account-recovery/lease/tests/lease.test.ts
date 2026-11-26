import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { saveAccountLink } from "../../link";
import { startAccountRecoveryPoller } from "../../poller";
import { AccountPollLease, activeAccountPoller, LEASE_STALE_MS } from "..";

async function configDir(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "granttap-poll-lease-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(async () => { delete process.env.GRANTTAP_CONFIG_DIR; await rm(root, { recursive: true, force: true }); });
  t.mock.method(process.stderr, "write", () => true);
  return root;
}

test("one process holds the poller lease; a stale or dead holder is taken over, a released one at once", async t => {
  const root = await configDir(t);
  let now = 1_000_000;
  const clock = () => now;
  const dead = new Set<number>();
  const alive = (pid: number) => !dead.has(pid);
  const monitor = new AccountPollLease("monitor", { now: clock, alive, pid: 101 });
  const service = new AccountPollLease("service", { now: clock, alive, pid: 202 });
  assert.equal(monitor.claim(), true);
  assert.equal(service.claim(), false);
  assert.equal(statSync(join(root, "account-poller-lease.json")).mode & 0o777, 0o600);
  assert.deepEqual(activeAccountPoller(now, alive), { role: "monitor", pid: 101 });
  now += LEASE_STALE_MS - 1;
  assert.equal(service.claim(), false, "a holder inside its window keeps the lease");
  assert.equal(monitor.claim(), true, "and renews it");
  now += LEASE_STALE_MS + 1;
  assert.equal(service.claim(), true, "a holder that stopped renewing is replaced");
  assert.equal(monitor.claim(), false);
  dead.add(202);
  assert.equal(activeAccountPoller(now, alive), null);
  assert.equal(monitor.claim(), true, "a holder whose process is gone is replaced at once");
  monitor.release();
  assert.equal(activeAccountPoller(now, alive), null);
  dead.delete(202);
  assert.equal(service.claim(), true, "a released lease is free at once");
  now -= 10 * LEASE_STALE_MS;
  assert.equal(monitor.claim(), true, "a renewal from the future is a clock that moved back");
});

const leaseModule = fileURLToPath(new URL("../index.ts", import.meta.url));
const claimScript = (hold: boolean) => `
  import { AccountPollLease } from ${JSON.stringify(leaseModule)};
  const lease = new AccountPollLease("chat");
  process.stdout.write(String(lease.claim()) + "\\n");
  ${hold ? "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));" : ""}
`;
const node = (script: string) => [process.execPath, ["--import", "tsx", "--input-type=module", "-e", script]] as const;

test("across real processes only one holds the lease, and a process that exits leaves it to the next", { timeout: 20_000 }, async t => {
  await configDir(t);
  const [bin, args] = node(claimScript(true));
  const holder = spawn(bin, args, { env: process.env, stdio: ["pipe", "pipe", "ignore"] });
  t.after(() => { holder.kill(); });
  const first = await new Promise<string>((resolve, reject) => {
    holder.stdout.once("data", chunk => resolve(String(chunk).trim()));
    holder.once("exit", code => reject(new Error(`holder exited ${code}`)));
  });
  assert.equal(first, "true");
  const second = spawnSync(...node(claimScript(false)), { env: process.env, encoding: "utf8" });
  assert.equal(second.stdout.trim(), "false", "a second process does not poll while the first lives");
  assert.equal(new AccountPollLease("service").claim(), false);
  const exited = new Promise(resolve => holder.once("exit", resolve));
  holder.stdin.end();
  await exited;
  const third = spawnSync(...node(claimScript(false)), { env: process.env, encoding: "utf8" });
  assert.equal(third.stdout.trim(), "true", "the lease of a process that is gone is taken over");
});

test("two pollers on one computer: only the lease holder asks the account server, the other takes over when it stops", async t => {
  await configDir(t);
  saveAccountLink({ accountId: "11111111-1111-4111-8111-111111111111",
    machineId: "22222222-2222-4222-8222-222222222222", machineToken: "A".repeat(43) });
  const asked = { monitor: 0, service: 0 };
  const fake = (who: keyof typeof asked): typeof fetch => async () => { asked[who]++; return Response.json({ requests: [] }); };
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const stopMonitor = startAccountRecoveryPoller("https://granttap.com", () => {},
    { role: "monitor", request: fake("monitor"), intervalMs: 15 });
  await wait(30);
  const stopService = startAccountRecoveryPoller("https://granttap.com", () => {},
    { role: "service", request: fake("service"), intervalMs: 15 });
  t.after(() => { stopMonitor(); stopService(); });
  await wait(120);
  assert.ok(asked.monitor >= 3, `the holder keeps polling (${asked.monitor})`);
  assert.equal(asked.service, 0, "the other process never polls while the holder runs");
  assert.deepEqual(activeAccountPoller(), { role: "monitor", pid: process.pid });
  stopMonitor();
  const before = asked.monitor;
  await wait(120);
  assert.equal(asked.monitor, before);
  assert.ok(asked.service >= 3, `the other process answers once the holder stops (${asked.service})`);
});
