import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

/** SweepLoom stays a separate MPL-2.0 executable. Only metadata tools are called. */
export async function callSweepLoom(tool: string): Promise<unknown> {
  if (!['list_ai_stores', 'list_sessions'].includes(tool)) throw new Error('Unsupported storage inspection');
  const candidates = [process.env.GRANTTAP_SWEEPLOOM_PATH,
    ...['.local/bin', '.cargo/bin'].map(folder => join(homedir(), folder, 'sweeploom')),
    '/opt/homebrew/bin/sweeploom', '/usr/local/bin/sweeploom'];
  let command: string | undefined;
  for (const path of candidates) {
    if (!path) continue;
    try { await access(path, constants.X_OK); command = path; break; } catch { /* next install location */ }
  }
  if (!command) throw new Error('SweepLoom unavailable');
  const client = new Client({ name: 'granttap-storage', version: '1.0.0' });
  const transport = new StdioClientTransport({ command, args: ['mcp'],
    env: getDefaultEnvironment(), stderr: 'ignore' });
  try {
    await client.connect(transport, { timeout: 10_000 });
    const result = await client.callTool({ name: tool, arguments: {} }, undefined, { timeout: 45_000 });
    if (result.isError || !Array.isArray(result.content)) throw new Error('Storage inspection failed');
    const row = result.content.find(item => item.type === 'text');
    if (!row || typeof row.text !== 'string' || row.text.length > 512_000) throw new Error('Invalid storage metadata');
    return JSON.parse(row.text);
  } finally { await client.close(); }
}
