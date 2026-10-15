import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OffloadInput, admitTaskOffload } from '../../../../bridge/src/task-routing/admission';
import { consumeAttributedCall } from '../../../../bridge/src/mesh/identity/call-scope';
import { sessionFromEnvironment } from '../mesh/session-env';

export function registerRoutingTool(server: McpServer, invoke = admitTaskOffload): void {
  server.registerTool('offload_task', {
    description: 'Request moving this same Task to a compatible computer in its Mesh, keeping the provider, model, effort and full '
      + 'visible conversation. Requires Automatic computer transfers enabled in GrantTap. Supply operationId and requirements. '
      + 'After awaiting_idle, finish the current reply without more tools: persistent MCP captures the complete conversation only '
      + 'after the turn ends. The computer is selected from fresh capacity, repository, hardware and native account evidence. '
      + 'No compatible report means wait, never a guessed destination. action=status inspects your own request; action=cancel '
      + 'cancels it before preparation starts. Never pass another chat or Task identity.',
    inputSchema: OffloadInput.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async input => {
    try {
      const proof = consumeAttributedCall('offload_task', input, Date.now(), sessionFromEnvironment());
      const result = await invoke(input, proof);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ...result,
        ...(result.status === 'awaiting_idle' ? { instruction: 'Finish this reply now without further tools. MCP will capture the complete conversation after this turn ends.' } : {}) }) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const,
        text: error instanceof Error ? error.message : 'The resource transfer request was not confirmed.' }] };
    }
  });
}
