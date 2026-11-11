import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from '../../reply/process';
import { providerExitFailure, providerSignIns, providerSignInFailure } from '../../reply/process/auth-failure';
import { providerAuthentication } from '../provider-command';

const EXPIRED = 'Failed to authenticate: this login reached its time limit and cannot be renewed. '
  + 'Run `claude auth login` to sign in again, or use `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN for unattended jobs';

/** A stand-in `claude` that says it is logged in, then refuses every run the way 2.x does. */
function fakeClaude(): { command: string; cleanup: () => void } {
  const folder = mkdtempSync(join(tmpdir(), 'granttap-expired-login-'));
  const command = join(folder, 'claude');
  writeFileSync(command, `#!${process.execPath}
if (process.argv.slice(2).join(' ') === 'auth status --json') {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
} else {
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true,
    result: ${JSON.stringify(EXPIRED)} }) + '\\n');
  process.exit(1);
}
`);
  chmodSync(command, 0o755);
  return { command, cleanup: () => rmSync(folder, { recursive: true, force: true }) };
}

test("Claude's expired login in its stream-json result asks for sign-in instead of a raw exit error", () => {
  const stdout = JSON.stringify({ type: 'result', is_error: true, result: EXPIRED });
  const message = providerExitFailure('/Users/me/.local/bin/claude', '', stdout, 1);
  assert.match(message, /^Sign-in required for Claude Code\. Open Devices/);
  assert.doesNotMatch(message, /stopped with code/);
});

test('other provider wordings for a missing login are recognized, unrelated authentication text is not', () => {
  for (const said of ['Invalid API key · Please run /login',
    'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
    'OAuth token has expired. Please obtain a new token or refresh your existing token.']) {
    assert.match(providerSignInFailure('/opt/claude', said)!, /Sign-in required for Claude Code/, said);
  }
  assert.equal(providerSignInFailure('/opt/claude', 'MCP server github failed to authenticate; continuing'), undefined);
  assert.equal(providerExitFailure('claude', 'boom', '', 2), 'claude exited with code 2: boom');
});

test('a refused run outranks a stale "logged in" status until the provider signs in or runs again', async () => {
  const { command, cleanup } = fakeClaude();
  try {
    providerSignIns.accepted('claude');
    assert.equal(await providerAuthentication('claude', command), 'signed-in');
    const result = await runProcess(command, ['-p', 'hello'], undefined, 10_000,
      () => ({ ok: true, text: 'incorrect success' }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /^Sign-in required for Claude Code/);
    assert.equal(await providerAuthentication('claude', command), 'signed-out');
    providerSignIns.accepted('claude');
    assert.equal(await providerAuthentication('claude', command), 'signed-in');
  } finally {
    providerSignIns.accepted('claude');
    cleanup();
  }
});
