import { accessSync, constants, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import type { CodingAgent } from '../../../../packages/protocol/schema';
import { executableOnPath, resolveClaudeBinary } from '../providers/claude-bin';
import { resolveCodexBinary } from '../providers/codex-bin';
import { resolveGrokBinary } from '../providers/grok-bin';
import { resolveCursorAgentBin } from '../reply/process/cursor-agent-bin';

export function providerCommand(agent: CodingAgent): string {
  switch (agent) {
    case 'claude': return resolveClaudeBinary().path;
    case 'codex': return resolveCodexBinary();
    case 'grok': return resolveGrokBinary();
    case 'cursor': return resolveCursorAgentBin();
  }
}

export function providerEnvironment(): NodeJS.ProcessEnv {
  const node = dirname(process.execPath);
  return { ...process.env, PATH: [node, process.env.PATH ?? ''].join(delimiter),
    NO_COLOR: '1', FORCE_COLOR: '0', DISABLE_AUTOUPDATER: '1', GROK_DISABLE_AUTOUPDATER: '1' };
}

export function loginArguments(agent: CodingAgent): string[] {
  if (agent === 'grok' || agent === 'codex') return ['login', '--device-auth'];
  return agent === 'claude' ? ['auth', 'login'] : ['login'];
}

/** Only known provider entry points are offered; loopback callbacks and token URLs are never relayed. */
export function allowedLoginURL(agent: CodingAgent, value: string): string | undefined {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password) return;
    if ([...u.searchParams.keys()].some(k => /^(access_token|refresh_token|id_token|client_secret)$/i.test(k))) return;
    const domains: Record<CodingAgent, string[]> = {
      grok: ['grok.com', 'x.ai'], codex: ['openai.com', 'chatgpt.com'],
      claude: ['claude.ai', 'claude.com', 'anthropic.com'], cursor: ['cursor.com', 'cursor.sh'],
    };
    if (domains[agent].some(domain => u.hostname === domain || u.hostname.endsWith('.' + domain))) return u.href;
    if (agent === 'grok' && process.env.GROK_OIDC_ISSUER
      && new URL(process.env.GROK_OIDC_ISSUER).hostname === u.hostname) return u.href;
  } catch { /* malformed or non-provider output */ }
}

export function installedProvider(command: string): boolean {
  try { accessSync(command.includes('/') ? command : executableOnPath(command, process.env) ?? command, constants.X_OK); return true; } catch { return false; }
}

type Authentication = 'signed-in' | 'signed-out' | 'unknown' | 'not-installed';

/** Presence is reported separately from a successful agent turn; credentials never leave their native store. */
export async function providerAuthentication(agent: CodingAgent, command = providerCommand(agent)): Promise<Authentication> {
  if (!installedProvider(command)) return 'not-installed';
  if (agent === 'grok') {
    try {
      const file = join(process.env.GRANTTAP_GROK_DIR ?? process.env.GROK_HOME ?? join(homedir(), '.grok'), 'auth.json');
      const data = JSON.parse(readFileSync(file, 'utf8'));
      return Object.values(data).some(value => value && typeof value === 'object'
        && typeof (value as { key?: unknown }).key === 'string') ? 'signed-in' : 'signed-out';
    } catch { return process.env.XAI_API_KEY ? 'signed-in' : 'unknown'; }
  }
  const args = agent === 'claude' ? ['auth', 'status', '--json']
    : agent === 'codex' ? ['login', 'status'] : ['status'];
  return new Promise(resolve => {
    let done = false, output = '';
    const child = spawn(command, args, { env: providerEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (value: Authentication) => {
      if (done) return; done = true; clearTimeout(timer); resolve(value);
    };
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish('unknown'); }, 8_000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-16_384); });
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-16_384); });
    child.on('error', () => finish('unknown'));
    child.on('close', code => {
      if (agent === 'claude') {
        try {
          const value = JSON.parse(output);
          if (typeof value.loggedIn === 'boolean') return finish(value.loggedIn ? 'signed-in' : 'signed-out');
        } catch { /* an old CLI can only provide unknown status */ }
      }
      if (agent === 'codex') return finish(code === 0 ? 'signed-in' : /not logged|not signed/i.test(output) ? 'signed-out' : 'unknown');
      if (/not logged|not signed|unauthenticated/i.test(output)) return finish('signed-out');
      finish(code === 0 && /logged in|authenticated|signed in/i.test(output) ? 'signed-in' : 'unknown');
    });
  });
}
