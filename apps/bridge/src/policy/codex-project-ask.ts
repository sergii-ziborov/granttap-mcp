import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { configDir } from "../config/paths";

const ASK_TTL_MS = 30_000;
const MAX_MARKERS = 32;
const MAX_MARKER_BYTES = 2_048;
const MARKER_NAME = /^[0-9a-f]{64}\.json$/;

const AskMarker = z.object({
  version: z.literal(1),
  argsHash: z.string().regex(/^[0-9a-f]{64}$/),
  reason: z.string().trim().min(1).max(512),
  nonce: z.string().regex(/^[0-9a-f]{32}$/),
  createdAt: z.number().nonnegative(),
  expiresAt: z.number().positive(),
}).strict();

export type CodexAskIdentity = {
  sessionId?: unknown;
  toolUseId?: unknown;
  toolName?: unknown;
  toolInput?: unknown;
};

export type ConsumedCodexProjectAsk = {
  reason: string;
  nonce: string;
};

export function recordCodexProjectAsk(
  input: CodexAskIdentity,
  reason: string,
  now = Date.now(),
): boolean {
  let identity: ReturnType<typeof callIdentity>;
  try {
    identity = callIdentity(input);
  } catch {
    return false;
  }
  const boundedReason = bounded(reason, 512);
  if (!identity || !boundedReason || !safeMarkerDirectory()) return false;
  pruneMarkers(now);
  if (liveMarkerCount() >= MAX_MARKERS) return false;
  const path = markerPath(identity.key);
  let created = false;
  try {
    const marker = AskMarker.parse({
      version: 1,
      argsHash: identity.argsHash,
      reason: boundedReason,
      nonce: randomBytes(16).toString("hex"),
      createdAt: now,
      expiresAt: now + ASK_TTL_MS,
    });
    writeFileSync(path, `${JSON.stringify(marker)}\n`, { flag: "wx", mode: 0o600 });
    created = true;
    chmodSync(path, 0o600);
    if (liveMarkerCount() > MAX_MARKERS) {
      unlinkSync(path);
      return false;
    }
    return true;
  } catch {
    if (created) {
      try {
        unlinkSync(path);
      } catch {
        // No usable partial marker survived this failed write.
      }
    }
    return false;
  }
}

export function consumeCodexProjectAsk(
  input: CodexAskIdentity,
  now = Date.now(),
): ConsumedCodexProjectAsk | undefined {
  const identity = callIdentity(input);
  if (!identity || !safeMarkerDirectory()) return undefined;
  const source = markerPath(identity.key);
  const claimed = `${source}.${process.pid}.${randomBytes(6).toString("hex")}.claim`;
  try {
    renameSync(source, claimed);
    const marker = readMarker(claimed);
    if (!marker || marker.expiresAt <= now || marker.argsHash !== identity.argsHash) return undefined;
    return { reason: marker.reason, nonce: marker.nonce };
  } catch {
    return undefined;
  } finally {
    try {
      unlinkSync(claimed);
    } catch {
      // A missing claim means another process never observed this marker.
    }
  }
}

function callIdentity(input: CodexAskIdentity): { key: string; argsHash: string } | undefined {
  const sessionId = bounded(input.sessionId, 256);
  const toolUseId = bounded(input.toolUseId, 256);
  const toolName = bounded(input.toolName, 240);
  if (!sessionId || !toolUseId || !toolName) return undefined;
  const argsHash = digest(JSON.stringify(canonical(input.toolInput ?? {})));
  return {
    argsHash,
    key: digest(JSON.stringify({ sessionId, toolUseId, toolName, argsHash })),
  };
}

function canonical(value: unknown): unknown {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined && item !== null) output[key] = canonical(item);
    }
    return output;
  }
  return value;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function markerDirectory(): string {
  return join(configDir(), "codex-project-asks");
}

function markerPath(key: string): string {
  return join(markerDirectory(), `${key}.json`);
}

function safeMarkerDirectory(): boolean {
  const directory = markerDirectory();
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return false;
    chmodSync(directory, 0o700);
    return true;
  } catch {
    return false;
  }
}

function pruneMarkers(now: number): void {
  for (const name of markerNames()) {
    const path = join(markerDirectory(), name);
    const marker = readMarker(path);
    if (marker && marker.expiresAt > now) continue;
    try {
      unlinkSync(path);
    } catch {
      // A concurrent consumer may already have claimed it.
    }
  }
}

function liveMarkerCount(): number {
  return markerNames().length;
}

function markerNames(): string[] {
  try {
    return readdirSync(markerDirectory()).filter((name) => MARKER_NAME.test(name));
  } catch {
    return [];
  }
}

function readMarker(path: string): z.infer<typeof AskMarker> | undefined {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_MARKER_BYTES) {
      return undefined;
    }
    const parsed = AskMarker.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function bounded(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim();
  return clean && clean.length <= maximum && !/[\u0000-\u001f\u007f]/.test(clean)
    ? clean
    : undefined;
}
