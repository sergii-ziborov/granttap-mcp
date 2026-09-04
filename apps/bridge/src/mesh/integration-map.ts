import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The other side of this repository's databases, topics, and APIs.
 *
 * A Task lives in one repository, but the work rarely does: a protocol change
 * lands in the producer and the consumer together, and nothing in the Mesh
 * knew the two were sides of one contract. `weavatrix-md` writes a small,
 * deterministic map of exactly that next to the README — precision over
 * recall, no runtime, no credentials — and this reads it. Only the map's own
 * claims are carried; a missing edge stays missing rather than guessed.
 */
export type IntegrationEdge = {
  peer: string;
  via: "database" | "kafka" | "api";
  /** The relation as the map states it: `produces`, `consumes`, `calls`, `called_by`, or `shares`. */
  relation: "produces" | "consumes" | "calls" | "called_by" | "shares";
  /** The topic, database, or route the edge runs through, when the map names it. */
  through?: string;
};

export const INTEGRATION_MAP_FILE = "WEAVATRIX.md";
const MAX_EDGES = 64;

/** Parse a `WEAVATRIX.md` body. Anything the map does not state is left out. */
export function parseIntegrationMap(markdown: string): IntegrationEdge[] {
  const edges: IntegrationEdge[] = [];
  let section: IntegrationEdge["via"] | undefined;
  let through: string | undefined;
  for (const raw of markdown.split("\n")) {
    const line = raw.trimEnd();
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      const name = heading[1]!.trim().toLowerCase();
      section = name === "database" ? "database" : name === "kafka" ? "kafka" : name === "api" ? "api" : undefined;
      through = undefined;
      continue;
    }
    if (!section) continue;
    const top = /^- (.+)$/.exec(line);
    const nested = /^ {2,}- (.+)$/.exec(line);
    if (top && !nested) {
      const item = strip(top[1]!);
      if (section === "api") {
        const edge = apiEdge(item);
        if (edge) push(edges, edge);
      } else {
        through = item;
      }
      continue;
    }
    if (nested) {
      const item = strip(nested[1]!);
      if (section === "database" && through) {
        push(edges, { peer: item, via: "database", relation: "shares", through });
      } else if (section === "kafka" && through) {
        const produces = /^produces\s*→\s*(.+)$/.exec(item);
        const consumes = /^consumes\s*←\s*(.+)$/.exec(item);
        if (produces) push(edges, { peer: strip(produces[1]!), via: "kafka", relation: "produces", through });
        else if (consumes) push(edges, { peer: strip(consumes[1]!), via: "kafka", relation: "consumes", through });
      } else if (section === "api") {
        const edge = apiEdge(item);
        if (edge) push(edges, edge);
      }
    }
  }
  return edges;
}

function apiEdge(item: string): IntegrationEdge | undefined {
  const calls = /^calls\s*→\s*(.+)$/.exec(item);
  const calledBy = /^called by\s*←\s*(.+)$/.exec(item);
  if (calls) return { peer: strip(calls[1]!), via: "api", relation: "calls" };
  if (calledBy) return { peer: strip(calledBy[1]!), via: "api", relation: "called_by" };
  return undefined;
}

function strip(value: string): string {
  return value.replace(/`/g, "").trim().slice(0, 160);
}

function push(edges: IntegrationEdge[], edge: IntegrationEdge): void {
  if (!edge.peer || edges.length >= MAX_EDGES) return;
  if (edges.some((item) => item.peer === edge.peer && item.via === edge.via
    && item.relation === edge.relation && item.through === edge.through)) return;
  edges.push(edge);
}

const MAX_MAP_BYTES = 256 * 1_024;
const MAX_CACHED = 128;
const cache = new Map<string, { mtimeMs: number; size: number; edges: IntegrationEdge[] }>();

/** The map committed in a repository root, if the repository keeps one. Re-read only when it changes. */
export function readIntegrationMap(root: string): IntegrationEdge[] {
  const path = join(root, INTEGRATION_MAP_FILE);
  let size: number;
  let mtimeMs: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_MAP_BYTES) return [];
    size = stat.size;
    mtimeMs = stat.mtimeMs;
  } catch {
    cache.delete(path);
    return [];
  }
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.edges;
  try {
    const edges = parseIntegrationMap(readFileSync(path, "utf8"));
    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
    cache.set(path, { mtimeMs, size, edges });
    return edges;
  } catch {
    return [];
  }
}

export function clearIntegrationMapCache(): void {
  cache.clear();
}
