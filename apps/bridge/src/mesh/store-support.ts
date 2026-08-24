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
