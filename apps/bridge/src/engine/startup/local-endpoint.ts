import { createHash } from "node:crypto";
import { win32 } from "node:path";

const PIPE_PREFIX = String.raw`\\.\pipe\granttap-engine-`;

/** Every local client and the daemon use the same user-scoped endpoint. */
export function engineSocketEndpoint(socketPath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return socketPath;
  if (socketPath.startsWith(PIPE_PREFIX) && /^[a-f0-9]{64}$/i.test(socketPath.slice(PIPE_PREFIX.length))) return socketPath;
  if (!/^[A-Za-z]:[\\/]/.test(socketPath)) throw Error("Engine IPC requires a local absolute configuration path.");
  const normalized = win32.normalize(socketPath).toLowerCase();
  return PIPE_PREFIX + createHash("sha256").update(normalized).digest("hex");
}
