/**
 * Which chat started each helper run, kept after the run is over.
 *
 * Only the run's live process names its parent, and it lives for half a
 * minute. The link is therefore written down the moment it is seen, keyed by
 * the run's throwaway folder: the folder is what the process and the
 * provider's own session record both carry, and each run has its own.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFile } from "../config/access/write-private";
import { configDir } from "../config/runtime/paths";
import { HISTORY_RETENTION_MS } from "../sessions/support/common";
import { helperRunFolder } from "./kinds";

export type HelperRunParentAgent = "claude" | "codex";

export type HelperRunLink = {
  folder: string;
  kind: string;
  parentAgent: HelperRunParentAgent;
  parentSessionId: string;
  capturedAt: number;
};

const MAX_LINKS = 2_000;
const SESSION_ID = /^[A-Za-z0-9._-]{8,128}$/;

export function helperRunLinksPath(): string {
  return join(configDir(), "helper-runs.json");
}

function valid(value: unknown): HelperRunLink | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const folder = typeof item.folder === "string" ? helperRunFolder(item.folder)?.folder : undefined;
  if (!folder || typeof item.kind !== "string" || !item.kind || item.kind.length > 40) return undefined;
  if (item.parentAgent !== "claude" && item.parentAgent !== "codex") return undefined;
  if (typeof item.parentSessionId !== "string" || !SESSION_ID.test(item.parentSessionId)) return undefined;
  if (typeof item.capturedAt !== "number" || !Number.isFinite(item.capturedAt)) return undefined;
  return { folder, kind: item.kind, parentAgent: item.parentAgent,
    parentSessionId: item.parentSessionId, capturedAt: item.capturedAt };
}

let cached: { path: string; stamp: string; links: Map<string, HelperRunLink> } | undefined;

function stampOf(path: string): string | undefined {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return undefined;
  }
}

function readLinks(): Map<string, HelperRunLink> {
  const path = helperRunLinksPath();
  const stamp = stampOf(path);
  if (!stamp) return new Map();
  if (cached?.path === path && cached.stamp === stamp) return cached.links;
  const links = new Map<string, HelperRunLink>();
  try {
    const stored = JSON.parse(readFileSync(path, "utf8")) as { links?: unknown };
    for (const value of Array.isArray(stored.links) ? stored.links : []) {
      const link = valid(value);
      if (link && !links.has(link.folder)) links.set(link.folder, link);
    }
  } catch {
    // A file that cannot be read holds no links; the next capture rewrites it.
  }
  cached = { path, stamp, links };
  return links;
}

/** The chat that started the run in this folder, when it was captured. */
export function helperRunLink(folder: string | undefined): HelperRunLink | undefined {
  const key = helperRunFolder(folder)?.folder;
  return key ? readLinks().get(key) : undefined;
}

/** Write newly captured parents down. The first capture of a run stands. Returns how many were new. */
export function rememberHelperRunLinks(captured: readonly HelperRunLink[], now = Date.now()): number {
  const known = readLinks();
  const fresh = new Map<string, HelperRunLink>();
  for (const value of captured) {
    const link = valid(value);
    if (link && !known.has(link.folder) && !fresh.has(link.folder)) fresh.set(link.folder, link);
  }
  if (fresh.size === 0) return 0;
  const kept = [...known.values(), ...fresh.values()]
    .filter((link) => link.capturedAt >= now - HISTORY_RETENTION_MS)
    .sort((left, right) => left.capturedAt - right.capturedAt)
    .slice(-MAX_LINKS);
  const path = helperRunLinksPath();
  writePrivateFile(path, JSON.stringify({ version: 1, links: kept }));
  const stamp = stampOf(path);
  cached = stamp ? { path, stamp, links: new Map(kept.map((link) => [link.folder, link])) } : undefined;
  return fresh.size;
}
