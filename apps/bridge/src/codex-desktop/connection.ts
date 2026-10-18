import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';

type Response = { type: 'response'; requestId: string; method?: string; resultType: string;
  handledByClientId?: string; result?: any; error?: string };
type Pending = { method: string; target?: string; resolve: (response: Response) => void;
  reject: (error: Error) => void; timer: NodeJS.Timeout };
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** The desktop coordination socket is length-prefixed JSON, not another app-server. */
export class DesktopConnection {
  private readonly socket: Socket;
  private readonly pending = new Map<string, Pending>();
  private buffered = Buffer.alloc(0);
  private clientId = 'initializing-client';
  private closed = false;
  private readonly deadline: number;

  constructor(path: string, timeoutMs: number) {
    this.deadline = Date.now() + Math.min(5_000, timeoutMs);
    this.socket = connect(path);
    this.socket.on('error', () => this.close());
    this.socket.on('close', () => this.close());
    this.socket.on('data', chunk => {
      try { this.receive(chunk); } catch { this.close(); }
    });
  }

  async initialize(): Promise<void> {
    const response = await this.call('initialize', { clientType: 'desktop' }, 0);
    const id = response.result?.clientId;
    if (response.resultType !== 'success' || typeof id !== 'string' || !id || id.length > 180) {
      throw new Error('Codex desktop initialization is unavailable.');
    }
    this.clientId = id;
  }

  call(method: string, params: unknown, version: number, target?: string): Promise<Response> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('Codex desktop disconnected.'));
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Codex desktop has not confirmed the request.'));
      }, Math.max(1, this.deadline - Date.now()));
      this.pending.set(requestId, { method, target, resolve, reject, timer });
      this.send({ type: 'request', requestId, sourceClientId: this.clientId,
        method, params, version, ...(target ? { targetClientId: target } : {}) });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.buffered = Buffer.alloc(0);
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Codex desktop disconnected.'));
    }
    this.pending.clear();
  }

  private send(value: unknown): void {
    const body = Buffer.from(JSON.stringify(value));
    if (body.length > MAX_FRAME_BYTES) return this.close();
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(body.length);
    this.socket.write(Buffer.concat([prefix, body]));
  }

  private receive(chunk: Buffer): void {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    while (this.buffered.length >= 4) {
      const size = this.buffered.readUInt32LE();
      if (size === 0 || size > MAX_FRAME_BYTES) throw new Error('Invalid desktop frame.');
      if (this.buffered.length < size + 4) return;
      const message = JSON.parse(this.buffered.subarray(4, size + 4).toString());
      this.buffered = this.buffered.subarray(size + 4);
      this.handle(message);
    }
  }

  private handle(message: any): void {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    if (message.type === 'client-discovery-request') {
      this.send({ type: 'client-discovery-response', requestId: message.requestId,
        response: { canHandle: false } });
    } else if (message.type === 'request') {
      this.send({ type: 'response', requestId: message.requestId,
        resultType: 'error', error: 'no-handler-for-request' });
    } else if (message.type === 'response') {
      const request = this.pending.get(message.requestId);
      if (!request) return;
      if (message.method !== undefined && message.method !== request.method
          || message.resultType === 'success' && request.target && message.handledByClientId !== request.target) {
        return this.close();
      }
      this.pending.delete(message.requestId);
      clearTimeout(request.timer);
      request.resolve(message);
    }
  }
}
