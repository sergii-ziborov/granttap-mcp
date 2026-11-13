import { request } from "node:http";
import { SignInCallback } from "../../../../../packages/protocol/schema";

/**
 * Hand the browser's redirect to the command that waits for it on this computer.
 *
 * A sign-in that ends at `http://localhost:<port>/…` ended on the phone, where
 * the browser was; the command that started it listens here. This repeats that
 * one request against the loopback address and nowhere else: the address is not
 * an argument, the port is the one the request declared, the method is GET, a
 * redirect in the answer is reported rather than followed, and the answer's
 * headers and body are dropped. Only the status code leaves this function.
 */
export type CallbackReplay =
  | { delivered: true; status: number }
  | { delivered: false; reason: "invalid" | "unreachable" };

/** A command may bind `localhost` to either family; both are this computer. */
const LOOPBACK = ["127.0.0.1", "::1"] as const;
const REPLAY_TIMEOUT_MS = 10_000;

type Attempt = { status: number } | "not_listening" | "failed";

export async function replayLoopbackCallback(
  port: number,
  callback: unknown,
  timeoutMs = REPLAY_TIMEOUT_MS,
): Promise<CallbackReplay> {
  const target = SignInCallback.safeParse(callback);
  if (!target.success || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return { delivered: false, reason: "invalid" };
  }
  const path = target.data.query ? `${target.data.path}?${target.data.query}` : target.data.path;
  const deadline = Date.now() + timeoutMs;
  for (const host of LOOPBACK) {
    const attempt = await getOnce(host, port, path, Math.max(1, deadline - Date.now()));
    if (attempt === "not_listening") continue;
    if (attempt === "failed") break;
    return { delivered: true, status: attempt.status };
  }
  return { delivered: false, reason: "unreachable" };
}

/**
 * One GET. "Not listening" means no connection was made, so nothing was sent
 * and the other loopback family may be tried; any failure after a connection
 * ends the replay, because the command may already have the redirect.
 */
function getOnce(host: string, port: number, path: string, timeoutMs: number): Promise<Attempt> {
  return new Promise((resolve) => {
    let connected = false;
    let settled = false;
    const finish = (attempt: Attempt) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(attempt);
    };
    const outgoing = request({
      host, port, path, method: "GET", agent: false,
      headers: { host: `localhost:${port}`, accept: "*/*" },
    }, (response) => {
      const status = response.statusCode ?? 0;
      response.resume();
      response.destroy();
      finish({ status });
    });
    const timer = setTimeout(() => {
      outgoing.destroy();
      finish(connected ? "failed" : "not_listening");
    }, timeoutMs);
    outgoing.once("socket", (socket) => socket.once("connect", () => { connected = true; }));
    outgoing.once("error", () => finish(connected ? "failed" : "not_listening"));
    outgoing.end();
  });
}
