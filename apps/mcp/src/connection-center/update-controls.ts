import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { setRuntimeAutoUpdate } from '../../../bridge/src/runtime-updates';
import { connectionOutput } from './state';

export function registerRuntimeUpdateControl(
  server: McpServer, result: () => CallToolResult, meta: Record<string, unknown>,
): void {
  server.registerTool('set_runtime_auto_update', {
    title: 'GrantTap automatic updates',
    description: 'Enable or disable automatic GrantTap runtime updates on this computer when the user requests it. Saves the preference without restarting services or changing pairing, tasks, or provider policy.',
    inputSchema: { enabled: z.boolean().describe('Whether this computer should automatically check for and apply stable GrantTap runtime updates') },
    outputSchema: connectionOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: meta,
  }, async ({ enabled }) => {
    try { setRuntimeAutoUpdate(enabled); return result(); }
    catch {
      return { isError: true, content: [{ type: 'text', text: 'Could not save automatic update settings. Service configuration may disable updates. Refresh status to see the current setting.' }] };
    }
  });
}
