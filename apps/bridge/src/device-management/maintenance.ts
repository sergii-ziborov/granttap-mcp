import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CodingAgent, DeviceManagementSnapshot } from '../../../../packages/protocol/schema';
import { configDir } from '../config/runtime/paths';
import { observedComputerId } from '../mesh/identity/computer';
import { automaticUpdatesAllowed } from '../runtime-updates/preferences/storage.mjs';
import { readState, runtimeVersion } from '../runtime-updates/selection.mjs';
import { checkForRuntimeUpdate } from '../runtime-updates';
import { binaryVersion } from '../tools/version';
import { providerCommand, providerAuthentication, installedProvider, providerEnvironment } from './provider-command';
import { computerCache } from './cache';
import { providerLogins } from './login';
import { ownedProviderProcesses, signalOwnedProcess } from '../reply/process';
import { approvalsStatus } from '../approvals/state';

export const runtimeRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const runtimeEpoch = randomUUID();
const agents: CodingAgent[] = ['grok', 'claude', 'codex', 'cursor'];

export function runtimeRestartSupported(): boolean {
  if (process.platform !== 'darwin' || !process.getuid || !runtimeRoot.includes('/node_modules/')) return false;
  return ['com.granttap.monitor', 'com.granttap.mcp-http'].every(label => {
    try {
      const plist = readFileSync(join(homedir(), 'Library', 'LaunchAgents', label + '.plist'), 'utf8');
      return plist.includes('<string>' + label + '</string>') && plist.includes('/granttap-mcp/bin/granttap-mcp.mjs')
        && plist.includes('<key>KeepAlive</key>');
    } catch { return false; }
  });
}

export function maintenanceIdle(): boolean {
  return !providerLogins.active() && approvalsStatus().pending.length === 0
    && agents.every(agent => ownedProviderProcesses(providerCommand(agent)).length === 0);
}

export async function managementSnapshot(): Promise<DeviceManagementSnapshot> {
  const directory = join(configDir(), 'runtime-updates');
  const selected = readState(directory);
  const providers = await Promise.all(agents.map(async agent => {
    const command = providerCommand(agent), installed = installedProvider(command);
    return { agent, installed, version: binaryVersion(command), authentication: await providerAuthentication(agent, command),
      loginSupported: installed, restartSupported: installed,
      activeRequests: ownedProviderProcesses(command).length };
  }));
  return { computerId: observedComputerId(), computerName: hostname(), observedAt: Date.now(),
    runtimeVersion: runtimeVersion(runtimeRoot), runtimeEpoch, selectedRuntimeVersion: selected.version,
    automaticUpdatesEnabled: automaticUpdatesAllowed(directory),
    runtimeUpdateSupported: runtimeRoot.includes('/node_modules/'), runtimeRestartSupported: runtimeRestartSupported(),
    cache: (await computerCache(runtimeRoot)).map(({ paths: _paths, ...category }) => category), providers };
}

export async function updateRuntime(): Promise<string> {
  if (!runtimeRoot.includes('/node_modules/')) throw Error('This is a development checkout. Update the installed MCP instead.');
  const candidate = await checkForRuntimeUpdate({ root: runtimeRoot, stateDirectory: join(configDir(), 'runtime-updates'),
    idle: maintenanceIdle, manual: true });
  return candidate ? 'MCP update verified and selected. Restart MCP to activate it.'
    : 'No newer published MCP is available, or activation is waiting for active work. The current MCP is retained.';
}

/** A detached, fixed command survives the monitor exiting. No phone-supplied command or path is executed. */
export function restartRuntime(): void {
  if (!runtimeRestartSupported()) throw Error('Managed MCP services are not installed on this computer.');
  if (!maintenanceIdle()) throw Error('Finish active requests, decisions and sign-in before restarting MCP.');
  const domain = 'gui/' + process.getuid!();
  const script = `setTimeout(() => { const { spawnSync } = require('node:child_process');
    for (const label of ['com.granttap.mcp-http','com.granttap.monitor'])
      spawnSync('/bin/launchctl',['kickstart','-k',${JSON.stringify(domain)}+'/'+label],{stdio:'ignore',timeout:10000}); }, 1200);`;
  const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' });
  child.unref();
}

export async function restartProvider(agent: CodingAgent, interrupt = false): Promise<string> {
  const command = providerCommand(agent);
  if (!installedProvider(command)) throw Error('This provider is not installed on the computer.');
  if (providerLogins.active()) throw Error('Finish sign-in before restarting a provider.');
  const children = ownedProviderProcesses(command);
  if (children.length && !interrupt) throw Error('This provider has active GrantTap requests. Confirm interruption before restarting.');
  await Promise.all(children.map(child => new Promise<void>(resolve => {
    const timer = setTimeout(() => { signalOwnedProcess(child, 'SIGKILL'); resolve(); }, 2_000);
    child.once('close', () => { clearTimeout(timer); resolve(); });
    (child as typeof child & { granttapStopped?: boolean }).granttapStopped = true;
    signalOwnedProcess(child, 'SIGTERM');
  })));
  await promisify(execFile)(command, ['--version'], { env: providerEnvironment(), timeout: 15_000, maxBuffer: 16_384 });
  return 'A fresh provider CLI started successfully. The next message starts a new GrantTap connection to it.';
}
