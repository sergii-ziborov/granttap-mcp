import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Write ~/.granttap files so a second save cannot fail on Windows overwrite. */
export function writePrivateFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, contents, { mode: 0o600 });
    if (process.platform === "win32" && existsSync(path)) unlinkSync(path);
    renameSync(temporary, path);
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
