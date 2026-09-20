import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const CODEX_BIN = process.env.GRANTTAP_CODEX_BIN ?? process.env.NODVOX_CODEX_BIN ?? "codex";

export type CompactResult = { ok: true } | { ok: false; error: string };

/**
 * Use Codex's documented app-server API rather than pretending that a prompt
 * saying "summarize" is context compaction. The caller only enables this for
 * idle Codex tasks so another active turn cannot race the persisted rollout.
 */
export function compactCodexSession(sessionId: string, timeoutMs = 240_000): Promise<CompactResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(CODEX_BIN, ["app-server", "--listen", "stdio://"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ ok: false, error: `Codex app-server did not start: ${(error as Error).message}` });
      return;
    }

    let done = false;
    let stderr = "";
    const finish = (result: CompactResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      lines.close();
      child.kill("SIGTERM");
      resolve(result);
    };
    const send = (message: unknown): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, error: "Codex did not finish context compaction in time." });
    }, timeoutMs);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-2_000);
    });

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }

      if (message.id === 1) {
        if (message.error) return finish({ ok: false, error: rpcError(message.error) });
        send({ method: "initialized", params: {} });
        send({ method: "thread/resume", id: 2, params: { threadId: sessionId, excludeTurns: true } });
        return;
      }
      if (message.id === 2) {
        if (message.error) return finish({ ok: false, error: rpcError(message.error) });
        send({ method: "thread/compact/start", id: 3, params: { threadId: sessionId } });
        return;
      }
      if (message.id === 3 && message.error) {
        finish({ ok: false, error: rpcError(message.error) });
        return;
      }

      const item = message.params?.item;
      if (message.method === "item/completed" && item?.type === "contextCompaction") {
        finish({ ok: true });
      } else if (message.method === "turn/completed" && message.params?.turn?.status === "failed") {
        finish({ ok: false, error: "Codex reported that context compaction failed." });
      }
    });

    child.on("error", (error) => finish({ ok: false, error: error.message }));
    child.on("close", (code) => {
      if (!done) {
        finish({
          ok: false,
          error: `Codex app-server exited with code ${code ?? "unknown"}${stderr.trim() ? `: ${stderr.trim().slice(-500)}` : ""}`,
        });
      }
    });

    send({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: { name: "granttap", title: "GrantTap", version: "0.3.0" },
        capabilities: { optOutNotificationMethods: ["item/agentMessage/delta"] },
      },
    });
  });
}

function rpcError(error: any): string {
  if (typeof error?.message === "string") return error.message;
  return typeof error === "string" ? error : "Unknown Codex app-server error.";
}
