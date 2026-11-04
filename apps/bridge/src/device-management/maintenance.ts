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
import { newerVersion, readState, runtimeVersion } from '../runtime-updates/selection.mjs';
import { latestRelease, trustedRelease } from '../runtime-updates/registry';
import { checkForRuntimeUpdate } from '../runtime-updates';
import { binaryVersion } from '../tools/version';
import { providerCommand, providerAuthentication, installedProvider, providerEnvironment } from './provider-command';
import { computerCache } from './cache';
import { providerLogins } from './login';
import { ownedProviderProcesses } from '../reply/process';
import { prepareRuntimeRestart, stopOwnedChildren } from './runtime-restart';
import { approvalsStatus } from '../approvals/state';
import { inspectTool, updateTool } from '../tools/updater';

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

const RELEASE_CHECK_MS = 60 * 60_000;
let knownRelease: { at: number; version?: string } = { at: 0 };

/** The phone offers an update from this answer; a registry problem only hides the offer. */
async function availableRuntimeVersion(): Promise<string | undefined> {
  if (Date.now() - knownRelease.at >= RELEASE_CHECK_MS) {
    knownRelease = { at: Date.now(), version: knownRelease.version };
    try {
      const release = await latestRelease();
      if (trustedRelease(release)) knownRelease.version = release.version;
    } catch { /* Keep what was last known. */ }
  }
  const version = knownRelease.version;
  return version && newerVersion(version, runtimeVersion(runtimeRoot)) ? version : undefined;
}

export async function managementSnapshot(): Promise<DeviceManagementSnapshot> {
  const observedAt = Date.now();
  const directory = join(configDir(), 'runtime-updates');
  const selected = readState(directory);
  const providers = await Promise.all(agents.map(async agent => {
    const command = providerCommand(agent), installed = installedProvider(command);
    return { agent, installed, version: binaryVersion(command), authentication: await providerAuthentication(agent, command),
      loginSupported: installed, restartSupported: installed,
      updateSupported: installed && inspectTool(agent, providerEnvironment()).update != null,
      activeRequests: ownedProviderProcesses(command).length };
  }));
  return { computerId: observedComputerId(), computerName: hostname(), observedAt,
    runtimeVersion: runtimeVersion(runtimeRoot), runtimeEpoch, selectedRuntimeVersion: selected.version,
    availableRuntimeVersion: await availableRuntimeVersion(),
    automaticUpdatesEnabled: automaticUpdatesAllowed(directory),
    runtimeUpdateSupported: runtimeRoot.includes('/node_modules/'), runtimeRestartSupported: runtimeRestartSupported(),
    cache: (await computerCache(runtimeRoot)).map(({ paths: _paths, ...category }) => category), providers };
}

export async function updateRuntime(): Promise<string> {
  if (!runtimeRoot.includes('/node_modules/')) throw Error('This is a development checkout. Update the installed MCP instead.');
  const candidate = await checkForRuntimeUpdate({ root: runtimeRoot, stateDirectory: join(configDir(), 'runtime-updates'),
    idle: maintenanceIdle, manual: true });
  return candidate ? 'MCP update verified and selected. Restart MCP to activate it.'
    : 'No newer published MCP is available, or another update is still installing. The current MCP is retained.';
}

const ownedRuns = () => agents.flatMap(agent => ownedProviderProcesses(providerCommand(agent)));

/** Stops GrantTap's own runs only when the phone confirmed it; see `prepareRuntimeRestart`. */
export function prepareRestart(interrupt: boolean): Promise<void> {
  return prepareRuntimeRestart({ supported: runtimeRestartSupported, signingIn: () => providerLogins.active(),
    pendingDecisions: () => approvalsStatus().pending.length, activeRuns: ownedRuns, stop: stopOwnedChildren }, interrupt);
}

/** A detached, fixed command survives the monitor exiting. No phone-supplied command or path is executed. */
export function restartRuntime(): void {
  if (!runtimeRestartSupported()) throw Error('Managed MCP services are not installed on this computer.');
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
  await stopOwnedChildren(children);
  await promisify(execFile)(command, ['--version'], { env: providerEnvironment(), timeout: 15_000, maxBuffer: 16_384 });
  return 'A fresh provider CLI started successfully. The next message starts a new GrantTap connection to it.';
}

export async function updateProvider(agent: CodingAgent): Promise<string> {
  if (providerLogins.active()) throw Error('Finish provider sign-in before updating coding tools.');
  if (ownedProviderProcesses(providerCommand(agent)).length) throw Error('Finish this provider’s active GrantTap requests before updating it.');
  const outcome = await updateTool(agent, providerEnvironment());
  if (!outcome.ok) throw Error(outcome.message);
  return outcome.message;
}
