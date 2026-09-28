import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { EngineFrameDecoder, encodeEngineFrame } from '../../../../bridge/src/engine/protocol/engine-protocol';

export async function invokeDesktop(socketPath: string, operation: string, input: unknown,
  timeout: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const id = randomUUID();
    const decoder = new EngineFrameDecoder();
    const finish = (error?: Error, result?: unknown) => {
      socket.removeAllListeners(); socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    socket.setTimeout(timeout, () => finish(new Error('Desktop invocation timeout')));
    socket.once('error', error => finish(error));
    socket.once('end', () => finish(new Error('Desktop invocation closed')));
    socket.once('connect', () => socket.write(encodeEngineFrame({
      protocol_version: 1, request_id: id, operation, ...(input === undefined ? {} : { input }),
    })));
    socket.on('data', chunk => {
      try {
        const rows = decoder.push(chunk);
        if (!rows.length) return;
        const row = rows[0];
        if (!row || rows.length !== 1 || row.protocol_version !== 1 || row.request_id !== id
          || row.status !== 'ok' || !row.result || typeof row.result !== 'object') {
          finish(new Error('Invalid desktop response')); return;
        }
        finish(undefined, row.result);
      } catch { finish(new Error('Invalid desktop frame')); }
    });
  });
}
