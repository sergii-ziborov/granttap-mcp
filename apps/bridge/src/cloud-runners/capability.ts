import { execFile } from "node:child_process";
import { homedir } from "node:os";

export type CloudRunnerSupport = { claude: boolean; codex: boolean };
export type CloudBinaries = { claude: string; codex: string };
type Probe = (binary: string, args: string[]) => Promise<string>;

const REFRESH_MS = 10 * 60_000;

/** Claude Code documents `--cloud [description|session_id|url]` in its help. */
export function claudeSupportsCloud(help: string): boolean {
  return /^\s*--cloud \[description/m.test(help);
}

/** Codex documents `codex cloud exec … --env <ENV_ID>` for a non-interactive submission. */
export function codexSupportsCloud(help: string): boolean {
  return /Usage: codex cloud exec\b/.test(help) && /--env <ENV_ID>/.test(help);
}

function readHelp(binary: string, args: string[]): Promise<string> {
  return new Promise(resolve => execFile(binary, args,
    { cwd: homedir(), timeout: 10_000, maxBuffer: 512_000, windowsHide: true },
    (error, stdout) => resolve(error ? "" : stdout)));
}

/**
 * Help text is read in the background and kept ten minutes per binary, so a
 * status cycle never waits on a CLI and an updated CLI is asked again.
 */
export function createCloudSupportCache(probe: Probe = readHelp, clock = Date.now) {
  const known = new Map<string, { at: number; supported: boolean }>();
  const running = new Map<string, Promise<void>>();
  const ask = (key: string, binary: string, args: string[], test: (help: string) => boolean): boolean => {
    const entry = known.get(key);
    if ((!entry || clock() - entry.at > REFRESH_MS) && !running.has(key)) {
      running.set(key, probe(binary, args).then(help => { known.set(key, { at: clock(), supported: test(help) }); },
        () => { known.set(key, { at: clock(), supported: false }); })
        .finally(() => running.delete(key)));
    }
    return entry?.supported ?? false;
  };
  return {
    current(binaries: CloudBinaries): CloudRunnerSupport {
      return {
        claude: ask(`claude\u001f${binaries.claude}`, binaries.claude, ["--help"], claudeSupportsCloud),
        codex: ask(`codex\u001f${binaries.codex}`, binaries.codex, ["cloud", "exec", "--help"], codexSupportsCloud),
      };
    },
    async settled(): Promise<void> {
      await Promise.all([...running.values()]);
    },
  };
}
