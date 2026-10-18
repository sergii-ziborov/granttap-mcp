import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Only the user's existing desktop router may receive a paired controller's input. */
export function desktopSocketPath(): string | undefined {
  if (process.platform === 'win32') return undefined;
  const root = process.env.GRANTTAP_CODEX_DIR ?? process.env.NODVOX_CODEX_DIR
    ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const directory = join(root, 'ipc');
  const socket = join(directory, 'ipc.sock');
  for (const [path, isSocket] of [[root, false], [directory, false], [socket, true]] as const) {
    try {
      const stat = lstatSync(path);
      if (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0
          || (isSocket ? !stat.isSocket() || (stat.mode & 0o077) !== 0 : !stat.isDirectory())) {
        throw new Error('The Codex desktop connection is not private.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  return socket;
}
