import { Socket } from "node:net";
import { configuredCursorHttpMcpUrl } from "../cursor-config";

/** Bounded TCP preflight so an unknown listener is never put into a restart fight. */
export async function isHttpMcpPortOccupied(
  mcpUrl = configuredCursorHttpMcpUrl(),
  timeoutMs = 400,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = new Socket();
    const finish = (occupied: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(occupied);
    };
    const url = new URL(mcpUrl);
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(Number(url.port), url.hostname.replace(/^\[(.*)\]$/, "$1"));
  });
}

/** Verify the expected process, not merely an arbitrary listener on the port. */
export async function probeHttpMcpHealth(
  mcpUrl = configuredCursorHttpMcpUrl(),
  timeoutMs = 1_500,
): Promise<boolean> {
  try {
    const expected = new URL(mcpUrl).href;
    const response = await fetch(new URL("/healthz", expected), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body = await response.json() as { ok?: unknown; service?: unknown; mcp?: unknown };
    return body.ok === true && body.service === "granttap-mcp" && body.mcp === expected;
  } catch {
    return false;
  }
}

export async function waitForHttpMcpHealth(
  mcpUrl = configuredCursorHttpMcpUrl(),
  timeoutMs = 8_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await probeHttpMcpHealth(mcpUrl, Math.min(1_000, timeoutMs))) return true;
    if (Date.now() >= deadline) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return false;
}
