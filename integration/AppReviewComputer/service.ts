import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { configDir, loadConfig, machineConfigPath } from '../../apps/bridge/src/config';
import { startAccountRecoveryPoller } from '../../apps/bridge/src/account-recovery/poller';
import { relay, resetRelay } from '../../apps/mcp/src/mcp-tools/connect/relay';
import { runReviewStep } from './walkthrough';

// Dedicated container mounts only its own GrantTap pairing and test-account machine token.
if (configDir() !== '/data/granttap') throw Error('Reviewer service requires its isolated data directory');
const client = await relay();
if (!client) throw Error('Reviewer computer could not connect');
const stopRecovery = startAccountRecoveryPoller('https://granttap.com', () => {
  const cfg = loadConfig(machineConfigPath());
  for (const key of cfg.extraPeerPublicKeys ?? []) client.addControllerPeer(key);
});
let stopping = false;
const health = createServer((_request, response) => {
  response.setHeader('content-type', 'application/json');
  response.statusCode = client.isConnected ? 200 : 503;
  response.end(JSON.stringify({ ok: client.isConnected, service: 'granttap-review-mcp', synthetic: true }));
});
health.listen(3212, '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  stopping = true; stopRecovery(); resetRelay(); health.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
});
while (!stopping) {
  try { await runReviewStep(client, configDir()); }
  catch { process.stderr.write('[review-mcp] Transport unavailable; retrying without logging message content.\n'); }
  await delay(1_000);
}
