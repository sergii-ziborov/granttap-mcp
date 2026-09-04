export function mergeBy<T>(
  current: T[],
  incoming: T[],
  key: (item: T) => string,
): T[] {
  const merged = new Map(current.map((item) => [key(item), item]));
  for (const item of incoming) merged.set(key(item), item);
  return [...merged.values()];
}

/** Same merge, but a rule decides which version of a duplicate survives. */
export function mergeWith<T>(
  current: T[],
  incoming: T[],
  key: (item: T) => string,
  prefer: (current: T, incoming: T) => T,
): T[] {
  const merged = new Map(current.map((item) => [key(item), item]));
  for (const item of incoming) {
    const existing = merged.get(key(item));
    merged.set(key(item), existing ? prefer(existing, item) : item);
  }
  return [...merged.values()];
}

function patternMatches(pattern: string, candidate: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*");
  return new RegExp(`^${escaped}$`).test(candidate);
}

export function resourceOverlap(left: string, right: string): boolean {
  if (left === right || patternMatches(left, right) || patternMatches(right, left)) return true;
  const prefix = (value: string) => value.split("*")[0]!.replace(/\/$/, "");
  const a = prefix(left);
  const b = prefix(right);
  return Boolean(a && b && (a.startsWith(b) || b.startsWith(a)));
}

/**
 * Directory segments that mark the start of a module; the deepest match wins.
 *
 * A conflict on the exact file is found late: by the time two agents touch
 * one file, the merge is already the problem. Two agents in one module are the
 * earlier warning, and a module is recognised from the path alone so every
 * computer and the phone reach the same answer with no filesystem to consult.
 */
const MODULE_CONTAINERS = new Set([
  "apps", "packages", "crates", "services", "modules", "libs", "features",
  "src", "lib", "internal", "cmd", "pkg", "sources", "tests",
]);

/**
 * The module a repository-relative path belongs to: the child of the deepest
 * container that is still a directory (`crates/X/src/a.rs` → `crates/X`,
 * `apps/ios/App/Features/Mesh/V.swift` → `apps/ios/App/Features/Mesh`), or the
 * parent directory when no container is in the path.
 */
export function moduleRoot(path: string): string {
  const parts = path.replace(/^\/+/, "").split("/").filter((part) => part && part !== ".");
  if (parts.length <= 1) return "";
  const last = parts.length - 1;
  for (let index = last - 1; index >= 0; index -= 1) {
    if (MODULE_CONTAINERS.has(parts[index]!.toLowerCase()) && index + 1 < last) {
      return parts.slice(0, index + 2).join("/");
    }
  }
  return parts.slice(0, last).join("/");
}

/** How two claimed resources collide: on the file itself, or within a module. */
export function overlapKind(left: string, right: string): "file" | "module" | null {
  if (resourceOverlap(left, right)) return "file";
  const a = moduleRoot(left);
  const b = moduleRoot(right);
  return a && b && a === b ? "module" : null;
}
