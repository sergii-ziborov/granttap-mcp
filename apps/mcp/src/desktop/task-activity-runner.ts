import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const requireFromHere = createRequire(import.meta.url);
const workerPath = fileURLToPath(new URL("./task-activity-worker.ts", import.meta.url));

type Pending = {
  id: string; payload: string; sent: boolean;
  resolve: (value: unknown) => void; timer?: NodeJS.Timeout;
};

/** Keeps transcript parsing off the HTTP and policy event loop. */
export class DesktopTaskActivityRunner {
  private child?: ChildProcessWithoutNullStreams;
  private ready = false;
  private closed = false;
  private pending?: Pending;
  private queue: Pending[] = [];
  private buffer = "";

  constructor() { this.start(); }

  read(query: unknown, storePath?: string): Promise<unknown> {
    if (this.closed || this.queue.length + (this.pending ? 1 : 0) >= 8) {
      return Promise.resolve(undefined);
    }
    if (query === null || typeof query !== "object" || Array.isArray(query)) {
      return Promise.resolve(undefined);
    }
    const { project_id: projectId, task_id: taskId } = query as Record<string, unknown>;
    if (typeof projectId !== "string" || !projectId || projectId.length > 128
      || typeof taskId !== "string" || !taskId || taskId.length > 128) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      const id = randomUUID();
      this.queue.push({
        id, payload: `${JSON.stringify({ id, query, storePath })}\n`,
        sent: false, resolve,
      });
      this.activateNext();
    });
  }

  close(): void {
    this.closed = true;
    this.finish(undefined);
    for (const item of this.queue.splice(0)) item.resolve(undefined);
    this.child?.kill("SIGKILL");
    this.child = undefined;
  }

  private start(): void {
    if (this.closed) return;
    this.ready = false;
    this.buffer = "";
    const child = spawn(process.execPath, [
      "--require", requireFromHere.resolve("tsx/preflight"),
      "--import", pathToFileURL(requireFromHere.resolve("tsx")).href,
      workerPath,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      if (this.buffer.length > 256 * 1_024) { child.kill("SIGKILL"); return; }
      for (;;) {
        const end = this.buffer.indexOf("\n");
        if (end < 0) break;
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        this.receive(line);
      }
    });
    child.on("error", () => {
      this.ready = false;
      this.finish(undefined);
    });
    child.on("close", () => {
      if (this.child !== child) return;
      this.child = undefined;
      this.ready = false;
      this.finish(undefined);
      if (!this.closed) setTimeout(() => this.start(), 1_000);
    });
  }

  private receive(line: string): void {
    try {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.ready === true) {
        this.ready = true;
        this.sendPending();
        return;
      }
      if (message.id !== this.pending?.id) return;
      const result = message.result as Record<string, unknown> | null;
      this.finish(result?.operation === "desktop.task_activity" ? result : undefined);
    } catch { this.finish(undefined); }
  }

  private finish(value: unknown): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(value);
    this.activateNext();
  }

  private activateNext(): void {
    if (this.closed || this.pending) return;
    this.pending = this.queue.shift();
    if (!this.pending) return;
    this.pending.timer = setTimeout(() => {
      const wasSent = this.pending?.sent === true;
      if (wasSent) this.ready = false;
      this.finish(undefined);
      if (wasSent) this.child?.kill("SIGKILL");
    }, 4_000);
    this.sendPending();
  }

  private sendPending(): void {
    if (!this.ready || !this.child || !this.pending || this.pending.sent) return;
    this.pending.sent = true;
    this.child.stdin.write(this.pending.payload);
  }
}
