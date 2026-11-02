import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { nextStep, sendPendingFaults, spendRestart } from '../policy.mjs';

const directoryFor = (t: { after: (run: () => void) => void }) => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-watchdog-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

/** A real process whose loop stops: only the watchdog thread can still act. */
function hang(directory: string, restartAllowed: boolean, hangMs: number, reportUrl?: string) {
  const entry = join(directory, 'hanging.ts');
  const watchdog = pathToFileURL(join(import.meta.dirname, '..', 'index.ts')).href;
  writeFileSync(entry, `import { startRuntimeWatchdog } from ${JSON.stringify(watchdog)};
    startRuntimeWatchdog({ directory: ${JSON.stringify(directory)}, version: '9.9.9', restartAllowed: ${restartAllowed},
      reportUrl: ${JSON.stringify(reportUrl)}, stallMs: 300, checkMs: 50 });
    setTimeout(() => { const end = Date.now() + ${hangMs}; while (Date.now() < end); process.exit(0); }, 100);`);
  const child = spawn(process.execPath, ['--no-warnings', '--import', 'tsx', entry], { stdio: 'ignore' });
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
    child.on('exit', (code, signal) => resolve({ code, signal })));
}

test('a hung process is killed after its fault is saved', async t => {
  const directory = directoryFor(t);
  const { signal } = await hang(directory, true, 15_000);
  assert.equal(signal, 'SIGKILL');
  const [report] = JSON.parse(readFileSync(join(directory, 'pending-reports.json'), 'utf8'));
  assert.equal(report.kind, 'event-loop-stall');
  assert.equal(report.action, 'restart');
  assert.deepEqual(Object.keys(report).sort(), ['action', 'arch', 'at', 'id', 'kind', 'node', 'platform',
    'restartsInWindow', 'stalledMs', 'version']);
  assert.equal(JSON.parse(readFileSync(join(directory, 'restarts.json'), 'utf8')).length, 1);
});

test('a spent restart budget leaves the process running and only reports', async t => {
  const directory = directoryFor(t);
  const now = Date.now();
  writeFileSync(join(directory, 'restarts.json'), JSON.stringify([now - 3_000, now - 2_000, now - 1_000]));
  const { code, signal } = await hang(directory, true, 1_500);
  assert.equal(signal, null);
  assert.equal(code, 0, 'the hang ended on its own and nothing killed it');
  const reports = JSON.parse(readFileSync(join(directory, 'pending-reports.json'), 'utf8'));
  assert.equal(reports.filter((report: { action: string }) => report.action === 'held').length, 1, 'one report per hang');
});

test('a monitor started by hand is never killed', async t => {
  const directory = directoryFor(t);
  const { code, signal } = await hang(directory, false, 1_000);
  assert.deepEqual({ code, signal }, { code: 0, signal: null });
  assert.equal(existsSync(join(directory, 'restarts.json')), false);
});

test('the report reaches the site before the kill', async t => {
  const directory = directoryFor(t);
  const received: Array<{ kind: string; version: string }> = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', part => { body += part; });
    request.on('end', () => { received.push(JSON.parse(body)); response.writeHead(204).end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address() as { port: number };
  const { signal } = await hang(directory, true, 15_000, `http://127.0.0.1:${port}/report`);
  assert.equal(signal, 'SIGKILL');
  assert.equal(received[0]?.kind, 'event-loop-stall');
  assert.equal(received[0]?.version, '9.9.9');
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'pending-reports.json'), 'utf8')), []);
});

test('the budget allows three restarts an hour and frees up as they age', t => {
  const directory = directoryFor(t);
  const hour = 3_600_000, start = 10 * hour;
  assert.deepEqual([0, 1, 2, 3].map(step => spendRestart(directory, start + step).restart), [true, true, true, false]);
  assert.equal(spendRestart(directory, start + hour + 5).restart, true);
});

test('sleep starts a grace period instead of counting as a hang', () => {
  const asleep = nextStep({ now: 1_000_000, lastCheck: 400_000, beat: 400_000, graceUntil: 0, reported: false });
  assert.equal(asleep.stalled, false);
  assert.equal(asleep.graceUntil, 1_120_000);
  const awake = nextStep({ now: 1_005_000, lastCheck: 1_000_000, beat: 1_004_500, graceUntil: asleep.graceUntil, reported: false });
  assert.equal(awake.stalled, false);
  const hung = nextStep({ now: 1_130_000, lastCheck: 1_125_000, beat: 1_004_500, graceUntil: asleep.graceUntil, reported: false });
  assert.equal(hung.stalled, true);
  assert.equal(nextStep({ now: 1_130_000, lastCheck: 1_125_000, beat: 1_129_000, graceUntil: 0, reported: true }).recovered, true);
});

test('a report the site refuses does not hold back the next one', async t => {
  const directory = directoryFor(t);
  writeFileSync(join(directory, 'pending-reports.json'), JSON.stringify([{ id: 'refused' }, { id: 'good' }]));
  let calls = 0;
  const request = (async () => new Response(null, { status: ++calls === 1 ? 400 : 204 })) as typeof fetch;
  assert.equal(await sendPendingFaults(directory, 'https://example.test', request), 2);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'pending-reports.json'), 'utf8')), []);
});

test('an unavailable site keeps reports for later', async t => {
  const directory = directoryFor(t);
  const report = { id: 'one', kind: 'event-loop-stall' };
  writeFileSync(join(directory, 'pending-reports.json'), JSON.stringify([report]));
  const refused = (async () => new Response('', { status: 404 })) as typeof fetch;
  assert.equal(await sendPendingFaults(directory, 'https://example.test', refused), 0);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'pending-reports.json'), 'utf8')), [report]);
  const accepted = (async () => new Response(null, { status: 204 })) as typeof fetch;
  assert.equal(await sendPendingFaults(directory, 'https://example.test', accepted), 1);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'pending-reports.json'), 'utf8')), []);
});
