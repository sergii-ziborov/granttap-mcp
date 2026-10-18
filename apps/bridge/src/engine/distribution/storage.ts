import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, parse } from "node:path";
import { protectWindowsEngineDirectory } from "./windows-storage";

/** Refuse links anywhere in the owned installation path before changing permissions. */
export async function privateEngineDirectory(directory: string): Promise<void> {
  if (!isAbsolute(directory)) throw new Error("Engine installation needs an absolute directory");
  const ancestors: string[] = []; let path = directory;
  while (path !== parse(path).root) { ancestors.unshift(path); path = dirname(path); }
  for (const ancestor of ancestors) {
    try {
      const metadata = await lstat(ancestor);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("Engine installation refuses linked directories");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(ancestor, { mode: 0o700 });
    }
  }
  if (process.platform === "win32") await protectWindowsEngineDirectory(directory);
  else await chmod(directory, 0o700);
}

export async function writeEngineExecutable(path: string, bytes: Buffer): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o700);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
