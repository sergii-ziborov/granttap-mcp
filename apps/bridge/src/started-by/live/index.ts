/**
 * Look at a headless run the moment its provider writes its transcript.
 *
 * Only a run's live process names the chat that started it (`../capture.ts`), and a run a usage limit
 * stops lives three or four seconds. Process samples (`machine-load`) come every two seconds while
 * chats work and every thirty while none does, so they missed most such runs. A provider writes a new
 * transcript within about a second of a run's start (a Codex `rollout-*.jsonl`, a Claude `<id>.jsonl`,
 * a Grok session's `chat_history.jsonl`), so a new one asks for one sample of the provider processes
 * at once. Samples are single-flight: transcripts that appear while one runs ask for one more after
 * it, however many they are, so a batch of hundreds of runs costs at most one listing per run, and
 * nothing is listed while no transcript appears. Only names and creation times are read, never a
 * file's contents. On macOS, where one stream watches a folder tree.
 */
import { existsSync, statSync, watch as watchTree } from "node:fs";
import { join } from "node:path";
import { claudeProjectsRoot, codexSessionsRoot, grokSessionsRoot } from "../../sessions/support/common";

export type TreeWatcher = { close(): void };
/** Watch a folder tree; `failed` is called once when the watch stops by itself. */
export type WatchTree = (root: string, changed: (event: string, name: string | null) => void, failed: () => void) => TreeWatcher;

/** A provider's sessions folder, and how its new transcripts are named within it. */
export type TranscriptRoot = { root: string; transcript: (name: string) => boolean };

export function providerTranscriptRoots(): TranscriptRoot[] {
  return [
    { root: codexSessionsRoot(), transcript: (name) => /(?:^|\/)rollout-[^/]+\.jsonl$/.test(name) },
    // A chat's transcript lies directly in its project folder; a subagent's lies deeper.
    { root: claudeProjectsRoot(), transcript: (name) => /^[^/]+\/[^/]+\.jsonl$/.test(name) },
    { root: grokSessionsRoot(), transcript: (name) => /(?:^|\/)chat_history\.jsonl$/.test(name) },
  ];
}

export type RunWatchOptions = {
  sample: () => Promise<unknown>;
  roots?: () => readonly TranscriptRoot[];
  watch?: WatchTree;
  /** When a file was made, or nothing when it is not there. */
  bornAt?: (path: string) => number | undefined;
  now?: () => number;
};

/** A transcript made longer ago than this is an old one moved, not a run starting. */
const FRESH_MS = 60_000;
const MAX_SEEN = 4_096;

const watchWithNode: WatchTree = (root, changed, failed) => {
  const watcher = watchTree(root, { recursive: true, persistent: false },
    (event, name) => changed(event, name == null ? null : String(name)));
  watcher.on("error", () => { watcher.close(); failed(); });
  return watcher;
};

function birth(path: string): number | undefined {
  try {
    const stat = statSync(path);
    return stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs;
  } catch {
    return undefined;
  }
}

/** One watch per monitor; `start` is cheap to call again and watches a folder that appeared since. */
export function createHeadlessRunWatch(options: RunWatchOptions) {
  const roots = options.roots ?? providerTranscriptRoots;
  const watch = options.watch ?? watchWithNode;
  const bornAt = options.bornAt ?? birth;
  const now = options.now ?? Date.now;
  const watchers = new Map<string, TreeWatcher>();
  const seen = new Set<string>();
  let running: Promise<void> | undefined;
  let again = false;
  let stopped = true;

  const sample = (): void => {
    if (running) { again = true; return; }
    running = (async () => {
      do {
        again = false;
        try { await options.sample(); } catch { /* The next transcript, or the next sample, tries again. */ }
      } while (again && !stopped);
    })().finally(() => { running = undefined; });
  };

  const changed = ({ root, transcript }: TranscriptRoot) => (event: string, name: string | null): void => {
    if (stopped || event !== "rename" || !name) return;
    const path = name.replace(/\\/g, "/");
    if (!transcript(path) || seen.has(`${root}\0${path}`)) return;
    const born = bornAt(join(root, path));
    if (born === undefined || now() - born > FRESH_MS) return;
    if (seen.size >= MAX_SEEN) seen.clear();
    seen.add(`${root}\0${path}`);
    sample();
  };

  return {
    start(): void {
      stopped = false;
      for (const item of roots()) {
        if (watchers.has(item.root) || !existsSync(item.root)) continue;
        try {
          const watcher = watch(item.root, changed(item), () => { if (watchers.get(item.root) === watcher) watchers.delete(item.root); });
          watchers.set(item.root, watcher);
        } catch {
          // A folder that cannot be watched is left to the process samples.
        }
      }
    },
    stop(): void {
      stopped = true;
      for (const watcher of watchers.values()) {
        try { watcher.close(); } catch { /* Already closed. */ }
      }
      watchers.clear();
      seen.clear();
    },
    /** The folders watched now. */
    watching(): string[] {
      return [...watchers.keys()];
    },
    /** For tests: the sample in flight, if any, has finished. */
    settled(): Promise<void> {
      return running ?? Promise.resolve();
    },
  };
}

export type HeadlessRunWatch = ReturnType<typeof createHeadlessRunWatch>;

/** The monitor's watch: on macOS, where one stream watches a whole folder tree. Elsewhere it does nothing. */
export function watchHeadlessRuns(sample: () => Promise<unknown>, platform = process.platform): HeadlessRunWatch {
  return createHeadlessRunWatch({ sample, ...(platform === "darwin" ? {} : { roots: () => [] }) });
}
