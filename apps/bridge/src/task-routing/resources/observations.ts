import { accessSync, constants, statSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectAgentIntegrations } from '../../install';
import { isProviderEnabled } from '../../config/runtime';
import type { RoutingCandidate } from '../index';

const run = promisify(execFile);

export async function measuredRepositoryRevision(path: string): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', ['-C', path, 'rev-parse', 'HEAD'], { timeout: 2_000, maxBuffer: 1_024, windowsHide: true });
    const value = stdout.trim();
    return /^[a-f0-9]{40,64}$/.test(value) ? value : undefined;
  } catch { return undefined; }
}

export async function measuredRepositoryRevisions(path: string): Promise<string[]> {
  try {
    const { stdout } = await run('git', ['-C', path, 'for-each-ref', '--sort=-committerdate', '--count=64', '--format=%(objectname)',
      'refs/heads', 'refs/remotes'], { timeout: 2_000, maxBuffer: 8_192, windowsHide: true });
    return [...new Set(stdout.trim().split(/\s+/).filter(value => /^[a-f0-9]{40,64}$/.test(value)))].slice(0, 64);
  } catch { return []; }
}

export async function measuredDiskCapacity(path: string): Promise<number | undefined> {
  try {
    const info = await statfs(path), value = info.bavail * info.bsize;
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  } catch { return undefined; }
}

/** Installed entry points and policy only; native advertised models prove availability separately. */
export function routingProviderEntryPoints(): RoutingCandidate['provider'][] {
  return inspectAgentIntegrations().filter(row => row.installed && isProviderEnabled(row.agent)).map(row => row.agent);
}

export function routingExecutableNames(env = process.env, platform = process.platform): string[] {
  const extensions = platform === 'win32' ? ['', '.exe', '.cmd', '.bat', '.com'] : [''];
  const roots = (env.PATH ?? '').split(delimiter).filter(Boolean);
  return ['git', 'node', 'python', 'python3', 'swift', 'xcodebuild', 'cmake', 'nvcc', 'docker', 'cargo', 'rustc',
    'go', 'java', 'npm', 'pnpm', 'yarn', 'dotnet', 'ruby', 'bundle', 'pip', 'uv', 'clang', 'gcc', 'make', 'ninja',
    'xcrun', 'adb', 'gradle', 'ffmpeg'].filter(name =>
    roots.some(root => extensions.some(extension => {
      try {
        const path = join(root, name + extension);
        accessSync(path, constants.X_OK);
        return statSync(path).isFile();
      } catch { return false; }
    })));
}
