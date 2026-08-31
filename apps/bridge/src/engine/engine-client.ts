import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import {
  DEFAULT_ENGINE_POLICY_TIMEOUT_MS,
  ENGINE_PROTOCOL_VERSION,
  EngineFrameDecoder,
  EngineProtocolError,
  EngineRemoteError,
  MAX_ENGINE_PENDING_REQUESTS,
  encodeEngineFrame,
  parseEngineResponse,
  type EngineOperation,
  type EngineResult,
} from "./engine-protocol";

export type EngineClientOptions = {
  socketPath: string;
  connectTimeoutMs?: number;
  maxPendingRequests?: number;
};

type PendingRequest = {
  expectedOperation: EngineResult["operation"];
  resolve: (result: EngineResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class EngineClient {
  private readonly socketPath: string;
  private readonly connectTimeoutMs: number;
  private readonly maxPendingRequests: number;
  private readonly pending = new Map<string, PendingRequest>();
  private socket?: Socket;
  private connecting?: Promise<void>;
  private decoder = new EngineFrameDecoder();
  private closed = false;

  constructor(options: EngineClientOptions) {
    this.socketPath = options.socketPath;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_ENGINE_POLICY_TIMEOUT_MS;
    this.maxPendingRequests = options.maxPendingRequests ?? MAX_ENGINE_PENDING_REQUESTS;
  }

  async request(
    operation: EngineOperation,
    options: { timeoutMs?: number } = {},
  ): Promise<EngineResult> {
    if (this.closed) throw new Error("engine client is closed");
    if (this.pending.size >= this.maxPendingRequests) {
      throw new Error("engine request capacity is exhausted");
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_ENGINE_POLICY_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    await withDeadline(this.ensureConnected(), remaining(deadline));
    if (this.pending.size >= this.maxPendingRequests) {
      throw new Error("engine request capacity is exhausted");
    }
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new Error("engine socket is unavailable");
    const requestId = randomUUID();
    const frame = encodeEngineFrame({
      protocol_version: ENGINE_PROTOCOL_VERSION,
      request_id: requestId,
      ...operation,
    });
    return new Promise<EngineResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("engine request deadline exceeded"));
      }, remaining(deadline));
      this.pending.set(requestId, {
        expectedOperation: expectedResultOperation(operation.operation),
        resolve,
        reject,
        timer,
      });
      socket.write(frame, (error) => {
        if (error) this.rejectRequest(requestId, error);
      });
    });
  }

  close(): void {
    this.closed = true;
    this.failAll(new Error("engine client closed"));
    this.socket?.destroy();
    this.socket = undefined;
  }

  private ensureConnected(): Promise<void> {
    if (this.socket && !this.socket.destroyed && this.socket.readyState === "open") {
      return Promise.resolve();
    }
    if (this.connecting) return this.connecting;
    this.connecting = this.openSocket().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private openSocket(): Promise<void> {
    this.decoder = new EngineFrameDecoder();
    const socket = createConnection(this.socketPath);
    this.socket = socket;
    socket.on("data", (chunk) => this.receive(chunk));
    socket.on("close", () => this.socketClosed(socket));
    socket.on("error", () => undefined);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("engine connection deadline exceeded"));
      }, this.connectTimeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  private receive(chunk: Buffer): void {
    try {
      for (const value of this.decoder.push(chunk)) {
        const requestId = typeof value.request_id === "string" ? value.request_id : "";
        const pending = this.pending.get(requestId);
        if (!pending) continue;
        try {
          const result = parseEngineResponse(value, requestId);
          if (result.operation !== pending.expectedOperation) {
            throw new EngineProtocolError("engine response operation mismatch");
          }
          this.finishRequest(requestId, () => pending.resolve(result));
        } catch (error) {
          if (error instanceof EngineRemoteError) {
            this.finishRequest(requestId, () => pending.reject(error));
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new EngineProtocolError(String(error));
      this.failAll(failure);
      this.socket?.destroy();
    }
  }

  private finishRequest(requestId: string, finish: () => void): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    finish();
  }

  private rejectRequest(requestId: string, error: Error): void {
    const pending = this.pending.get(requestId);
    if (pending) this.finishRequest(requestId, () => pending.reject(error));
  }

  private socketClosed(socket: Socket): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.failAll(new Error("engine socket closed"));
  }

  private failAll(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      this.finishRequest(requestId, () => pending.reject(error));
    }
  }
}

function remaining(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("engine request deadline exceeded")), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

function expectedResultOperation(
  operation: EngineOperation["operation"],
): EngineResult["operation"] {
  if (operation === "engine.ping") return "engine.pong";
  if (operation === "engine.version") return "engine.version";
  if (operation === "project.resolve") return "project.resolved";
  return "policy.evaluated";
}
