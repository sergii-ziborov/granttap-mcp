import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const MAX_FILES = 512;
const MAX_BYTES = 8 * 1024 * 1024;

/** Identity of the complete local skill bundle. Unknown or unsafe trees have no digest. */
export function skillBundleDigest(definitionPath: string): string | undefined {
  const root = dirname(definitionPath);
  const hash = createHash("sha256");
  const pending = [root];
  let files = 0;
  let bytes = 0;
  try {
    if (!lstatSync(definitionPath).isFile()) return undefined;
    while (pending.length > 0) {
      const directory = pending.pop()!;
      if (!lstatSync(directory).isDirectory()) return undefined;
      const entries = readdirSync(directory).sort().reverse();
      for (const entry of entries) {
        const path = join(directory, entry);
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) return undefined;
        if (stat.isDirectory()) {
          pending.push(path);
          continue;
        }
        if (!stat.isFile() || ++files > MAX_FILES || (bytes += stat.size) > MAX_BYTES) return undefined;
        const name = relative(root, path).replaceAll("\\", "/");
        const body = readFileSync(path);
        hash.update(`${name.length}:${name}:${body.length}:`);
        hash.update(body);
      }
    }
    return files > 0 ? hash.digest("hex") : undefined;
  } catch {
    return undefined;
  }
}
