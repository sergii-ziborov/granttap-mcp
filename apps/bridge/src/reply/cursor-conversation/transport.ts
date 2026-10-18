import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { providerProcessEnvironment, signalOwnedProcess, STOPPED_ERROR, trackProviderProcess } from "../process";

type RpcId = string | number;
type Waiter = { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type Incoming = { fingerprint: string; result: Promise<unknown>; done: boolean };
const MAX_FRAME = 2 * 1024 * 1024;

export class CursorRpc {
  readonly child: ChildProcessWithoutNullStreams;
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly pending = new Map<number, Waiter>();
  private readonly incoming = new Map<string, Incoming>();
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private nextId = 0;
  private failure?: Error;
  private readonly registrations = new Map<string, () => void>();
  private readonly deadline: NodeJS.Timeout;

  constructor(private readonly options: {
    command: string; args: string[]; cwd: string; key?: string; timeoutMs: number;
    onRequest: (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>;
    onUpdate: (params: unknown) => void;
  }) {
    this.child = spawn(options.command, options.args, { cwd: options.cwd,
      env: { ...providerProcessEnvironment(options.cwd), GRANTTAP_CURSOR_ACP: "1" },
      stdio: "pipe", detached: process.platform !== "win32" });
    if (options.key) this.track(options.key);
    this.deadline = setTimeout(() => this.fail(new Error("Cursor did not finish before the task deadline")), options.timeoutMs);
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    // Never print native diagnostics: they can contain credentials or retained prompts.
    this.child.stderr.resume();
    this.child.stdin.on("error", () => this.fail(new Error("The Cursor control channel closed")));
    this.child.once("error", () => this.fail(new Error("The Cursor process could not start")));
    this.child.once("close", () => {
      const stopped = (this.child as typeof this.child & { granttapStopped?: boolean }).granttapStopped;
      this.fail(new Error(stopped ? STOPPED_ERROR : "The Cursor process stopped before completing its reply"));
      clearTimeout(this.deadline);
      for (const unregister of this.registrations.values()) unregister();
      this.registrations.clear();
    });
  }

  track(key: string): void {
    if (!this.registrations.has(key)) this.registrations.set(key, trackProviderProcess(key, this.child));
  }

  request(method: string, params: unknown, timeoutMs = 20_000): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.size >= 16) return Promise.reject(new Error("Cursor request capacity is exhausted"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`Cursor did not answer ${method} before its deadline`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void { this.send({ jsonrpc: "2.0", method, params }); }

  close(): void {
    this.fail(new Error("The Cursor conversation ended"));
    clearTimeout(this.deadline);
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error; this.controller.abort();
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear();
    signalOwnedProcess(this.child, "SIGTERM");
    const kill = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) signalOwnedProcess(this.child, "SIGKILL");
    }, 500);
    kill.unref();
  }

  private send(message: unknown): void {
    if (this.failure || this.child.stdin.destroyed) return;
    const line = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(line) > MAX_FRAME) { this.fail(new Error("Cursor request exceeded its size limit")); return; }
    this.child.stdin.write(line);
  }

  private receive(chunk: Buffer): void {
    if (this.failure) return;
    this.buffer += this.decoder.write(chunk);
    while (this.buffer.includes("\n")) {
      const end = this.buffer.indexOf("\n"), line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (Buffer.byteLength(line) > MAX_FRAME) { this.fail(new Error("Cursor response exceeded its size limit")); return; }
      if (!line.trim()) continue;
      try { this.message(JSON.parse(line)); }
      catch { this.fail(new Error("Cursor returned an invalid control message")); return; }
    }
    if (Buffer.byteLength(this.buffer) > MAX_FRAME) this.fail(new Error("Cursor response exceeded its size limit"));
  }

  private message(message: Record<string, unknown>): void {
    if (!message || message.jsonrpc !== "2.0") throw new Error("Invalid JSON-RPC envelope");
    if (typeof message.method === "string") {
      if (typeof message.id === "string" || typeof message.id === "number") {
        void this.answer(message.id, message.method, message.params);
      } else if (message.method === "session/update") this.options.onUpdate(message.params);
      return;
    }
    if (typeof message.id !== "number") return;
    const waiter = this.pending.get(message.id); if (!waiter) return;
    this.pending.delete(message.id); clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(`Cursor rejected ${waiter.method}`));
    else waiter.resolve(message.result);
  }

  private async answer(id: RpcId, method: string, params: unknown): Promise<void> {
    const key = JSON.stringify(id), fingerprint = createHash("sha256").update(JSON.stringify([method, params])).digest("hex");
    let record = this.incoming.get(key);
    if (record && record.fingerprint !== fingerprint) { this.fail(new Error("Cursor reused a request ID with different input")); return; }
    if (!record) {
      while (this.incoming.size >= 64) {
        const completed = [...this.incoming].find(([, value]) => value.done);
        if (!completed) { this.fail(new Error("Cursor interaction capacity is exhausted")); return; }
        this.incoming.delete(completed[0]);
      }
      record = { fingerprint, result: Promise.resolve().then(() => this.options.onRequest(method, params, this.signal)), done: false };
      this.incoming.set(key, record);
    }
    try { this.send({ jsonrpc: "2.0", id, result: await record.result }); }
    catch { this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: "This Cursor interaction is not supported safely" } }); }
    finally { record.done = true; }
  }
}
