import { createHash } from 'node:crypto';
import type { RelayClient } from '../../../../packages/core/relay-client';
import type { DeviceManagementRequest, DeviceManagementResult } from '../../../../packages/protocol/schema';
import { loadConfig, machineConfigPath } from '../config';
import { observedComputerId } from '../mesh/identity/computer';
import { clearComputerCache } from './cache';
import { providerLogins } from './login';
import { managementSnapshot, maintenanceIdle, restartProvider, restartRuntime, runtimeRoot, updateRuntime } from './maintenance';

type Send = (result: DeviceManagementResult) => Promise<void>;
type Entry = { fingerprint: string; result?: DeviceManagementResult; pending?: Promise<void>; at: number; ttl: number };
const requests = new Map<string, Entry>();
let mutating = false;
export function deviceManagementWorkActive(): boolean { return [...requests.values()].some(entry => entry.pending != null); }

export async function handleDeviceManagement(client: RelayClient, request: DeviceManagementRequest,
  peer: string | undefined): Promise<boolean> {
  if (!peer) return false;
  if (!Number.isFinite(request.createdAt) || Math.abs(Date.now() - request.createdAt) > 120_000) return false;
  const machine = loadConfig(machineConfigPath());
  if (machine.role !== 'machine' || machine.room !== client.room
    || (machine.peerPublicKey !== peer && !machine.extraPeerPublicKeys?.includes(peer))) return false;
  const computerId = observedComputerId();
  if (request.computerId != null && request.computerId !== computerId) return false;
  // Sign-in material is deliberately non-durable and addressed only to the requesting paired controller.
  const send: Send = value => client.sendToPeer(value, peer, { reliable: false, urgent: true, ttlMs: 60_000 });
  const key = client.room + ':' + peer + ':' + request.requestId;
  const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  for (const [k, value] of requests) if (Date.now() - value.at > value.ttl && !value.pending) requests.delete(k);
  const previous = requests.get(key);
  if (previous) {
    if (previous.fingerprint !== fingerprint) return false;
    if (previous.pending) await previous.pending;
    if (previous.result) await send(previous.result);
    return true;
  }
  if (requests.size >= 128) return false;
  const entry: Entry = { fingerprint, at: Date.now(), ttl: request.action === 'status' ? 60_000 : 15 * 60_000 };
  requests.set(key, entry);
  const report: Send = async result => { entry.result = result; await send(result); };
  entry.pending = execute(request, client.room + ':' + peer, computerId, report)
    .catch(async () => { /* disconnected phones recover with a new status request */ })
    .finally(() => { entry.pending = undefined; });
  // Commands run independently of message delivery; repeated taps reuse their operation.
  return true;
}

async function execute(request: DeviceManagementRequest, scope: string, computerId: string, send: Send): Promise<void> {
  const base = { type: 'device.manage.result' as const, requestId: request.requestId, computerId,
    action: request.action, agent: request.agent };
  const result = (phase: DeviceManagementResult['phase'], message: string): DeviceManagementResult =>
    ({ ...base, phase, message, createdAt: Date.now() });
  const exclusive = request.action !== 'status' && !request.action.startsWith('provider-login');
  if (exclusive && mutating) { await send(result('failed', 'Another computer maintenance action is in progress.')); return; }
  if (exclusive) mutating = true;
  try {
    if (request.action.startsWith('provider-login')) {
      const emit = (login: NonNullable<DeviceManagementResult['login']>) => {
        const phase = login.phase === 'signed-in' || login.phase === 'cancelled' ? 'completed'
          : login.phase === 'failed' || login.phase === 'expired' ? 'failed' : 'waiting';
        void send({ ...result(phase, login.message), login }).catch(() => {});
      };
      const login = request.action === 'provider-login' ? providerLogins.start(scope, request.agent!, emit)
        : request.action === 'provider-login-code' ? providerLogins.code(scope, request.agent!, request.operationId!, request.code!)
        : providerLogins.cancel(scope, request.agent!, request.operationId ?? '');
      await send({ ...result('waiting', login.message), login }); return;
    }
    await send(result('running', request.action === 'status' ? 'Reading this computer…' : 'Working on this computer…'));
    if (request.action === 'status') providerLogins.replay(scope);
    let message = 'Computer status refreshed.';
    if (request.action === 'clear-cache') {
      if (!maintenanceIdle()) throw Error('Finish active requests and sign-in before clearing computer caches.');
      const bytes = await clearComputerCache(runtimeRoot);
      message = `Cleared ${(bytes / 1024 / 1024).toFixed(1)} MB of disposable cache.`;
    } else if (request.action === 'runtime-update' || request.action === 'runtime-install') {
      message = await updateRuntime();
    } else if (request.action === 'provider-restart') {
      message = await restartProvider(request.agent!, request.interruptActiveTasks);
    } else if (request.action === 'runtime-restart') {
      // The phone waits for a different runtimeEpoch, rather than treating this acknowledgement as a restart.
      if (!maintenanceIdle()) throw Error('Finish active requests and sign-in before restarting MCP.');
      await send(result('waiting', 'Restart requested. Waiting for MCP to reconnect…'));
      restartRuntime(); return;
    }
    await send({ ...result('completed', message), snapshot: await managementSnapshot() });
  } catch (error) {
    await send(result('failed', error instanceof Error ? error.message.slice(0, 512) : 'This action failed on the computer.'));
  } finally { if (exclusive) mutating = false; }
}
