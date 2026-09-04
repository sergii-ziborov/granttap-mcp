import { spawn } from "node:child_process";
import type { ReplyResult } from "./types";

export function runProcess(
  command: string,
  args: string[],
  cwd: string | undefined,
  timeoutMs: number,
  parse: (stdout: string) => ReplyResult,
  stdin?: string,
): Promise<ReplyResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        // A delivery is itself a prompt submission; the prompt hook must not
        // hand a background run the journal kept for the live session.
        env: { ...process.env, GRANTTAP_DELIVERY: "1" },
        stdio: [stdin == null ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ ok: false, error: `${command} did not start: ${(error as Error).message}` });
      return;
    }
    if (stdin != null) child.stdin?.end(stdin);
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGKILL");
      resolve({ ok: false, error: `${command} did not respond within ${Math.round(timeoutMs / 1000)}s.` });
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, error: `${command}: ${error.message}` });
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        resolve({
          ok: false,
          error: `${command} exited with code ${code}: ${stderr.trim().slice(0, 300)}`,
        });
        return;
      }
      resolve(parse(stdout));
    });
  });
}
