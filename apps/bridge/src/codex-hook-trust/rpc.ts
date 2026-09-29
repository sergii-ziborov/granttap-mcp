import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { resolveCodexBinary } from "../providers/codex-bin";

export type HookRpcOptions = { binary?: string; cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number };
export type HookRpc = (method: string, params: unknown) => Promise<unknown>;

/** No threads or turns are created, and no hook commands are executed. */
export function codexHookRpc(options: HookRpcOptions = {}): HookRpc {
  return (method, params) => new Promise((resolve, reject) => {
    const env = options.env ?? process.env;
    const codexHome = env.GRANTTAP_CODEX_DIR ?? env.NODVOX_CODEX_DIR ?? env.CODEX_HOME;
    const child = spawn(options.binary ?? resolveCodexBinary(homedir(), env), ["app-server", "--listen", "stdio://"], {
      cwd: options.cwd ?? homedir(), env: { ...env, ...(codexHome ? { CODEX_HOME: codexHome } : {}) },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const lines = createInterface({ input: child.stdout });
    let bytes = 0;
    let finished = false;
    const finish = (value?: unknown, failed = false) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.destroy();
      child.kill("SIGTERM");
      if (failed) reject(new Error("Codex hook status is unavailable."));
      else resolve(value);
    };
    const timer = setTimeout(() => finish(undefined, true), options.timeoutMs ?? 5_000);
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + "\n");
    child.stdin.on("error", () => finish(undefined, true));
    child.on("error", () => finish(undefined, true));
    child.on("close", () => finish(undefined, true));
    lines.on("line", (line) => {
      bytes += Buffer.byteLength(line);
      if (bytes > 2_000_000) return finish(undefined, true);
      let message: any;
      try { message = JSON.parse(line); } catch { return; }
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      if (message.id === 1) {
        if (message.error) return finish(undefined, true);
        send({ method: "initialized", params: {} });
        send({ id: 2, method, params });
      } else if (message.id === 2) {
        finish(message.result, Boolean(message.error));
      }
    });
    send({ id: 1, method: "initialize", params: {
      clientInfo: { name: "granttap_hook_review", title: "GrantTap", version: "0.8.28" },
      capabilities: { experimentalApi: true },
    } });
  });
}
