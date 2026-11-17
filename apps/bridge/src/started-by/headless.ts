/**
 * Which provider processes are headless runs, and which commands a chat runs start one.
 *
 * A chat starts another provider's chat by running it headless from its shell: `codex exec`,
 * `claude -p` (or `--print`, or the SDK's stream-json input), `grok -p`. A run that resumes an earlier
 * chat (`codex exec resume`, `claude -p --resume`) starts no chat of its own. Interactive sessions are
 * never children: a terminal or tmux started from a chat's shell hands every session typed in it the
 * chat's id, so the variable alone does not say a chat started them.
 */

export type LineageAgent = "claude" | "codex" | "grok" | "cursor";

const AGENTS: readonly LineageAgent[] = ["claude", "codex", "grok", "cursor"];
export const SESSION_ID = /^[A-Za-z0-9._-]{8,128}$/;

export function lineageAgent(value: unknown): value is LineageAgent {
  return typeof value === "string" && (AGENTS as readonly string[]).includes(value);
}

/** What a provider process's command line says about the run. */
export type HeadlessRun = {
  headless: boolean;
  /** It continues an earlier chat instead of starting one. */
  resume: boolean;
  /** The chat id the command gives the new session, when it names one (`--session-id`). */
  sessionId?: string;
  /** The working folder the command names (`-C`, `--cd`, `--cwd`), when it is absolute. */
  folder?: string;
};

/** Codex options that take a value as the next word. */
const CODEX_VALUE_FLAGS = new Set(["-c", "--config", "-m", "--model", "-p", "--profile", "-C", "--cd", "-s",
  "--sandbox", "-a", "--ask-for-approval", "-i", "--image", "--enable", "--disable", "--local-provider",
  "--add-dir", "--color", "--output-last-message", "-o", "--output-schema"]);

function leaf(word: string): string {
  return (word.replace(/["']/g, "").split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.(m?js|cjs|exe|cmd)$/, "");
}

/**
 * A word as the program receives it: its quotes dropped, and so a list's brackets and comma, so that
 * `subprocess.run(["codex", "exec", "-C", "/tmp/art", prompt])` reads as the command it runs.
 */
function bare(word: string): string {
  const plain = word.replace(/^[[(]+/, "").replace(/[,\])]+$/, "");
  return /^(["'])[^"']*\1$/.test(plain) ? plain.slice(1, -1) : plain;
}

/** The words after the provider's own executable or script, or nothing when the line does not name it. */
function argumentsAfter(agent: LineageAgent, command: string): string[] | undefined {
  const words = command.slice(0, 16_384).trim().split(/\s+/).map(bare);
  const at = words.findIndex((word) => leaf(word) === agent || (agent === "cursor" && leaf(word) === "cursor-agent"));
  return at < 0 ? undefined : words.slice(at + 1);
}

function valueAfter(words: readonly string[], names: readonly string[]): string | undefined {
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    for (const name of names) {
      if (word === name) return words[index + 1];
      if (word.startsWith(`${name}=`)) return word.slice(name.length + 1);
    }
  }
  return undefined;
}

function absoluteFolder(value: string | undefined): string | undefined {
  return value && (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) ? value : undefined;
}

function codexRun(words: readonly string[]): HeadlessRun {
  const positional: string[] = [];
  for (let index = 0; index < words.length && positional.length < 2; index += 1) {
    const word = words[index]!;
    if (word === "--") break;
    if (word.startsWith("-")) {
      if (CODEX_VALUE_FLAGS.has(word)) index += 1;
      continue;
    }
    positional.push(word);
  }
  const headless = positional[0] === "exec" || positional[0] === "e";
  return { headless, resume: headless && positional[1] === "resume",
    folder: absoluteFolder(valueAfter(words, ["-C", "--cd"])) };
}

function promptRun(words: readonly string[], prints: readonly string[], resumes: readonly string[]): HeadlessRun {
  const has = (names: readonly string[]) => words.some((word) => names.some((name) => word === name || word.startsWith(`${name}=`)));
  const sdk = words.some((word, index) => word === "--input-format" && words[index + 1] === "stream-json")
    || words.includes("--input-format=stream-json");
  const sessionId = valueAfter(words, ["--session-id"]);
  return {
    headless: has(prints) || sdk, resume: has(resumes),
    ...(sessionId && SESSION_ID.test(sessionId) ? { sessionId } : {}),
    folder: absoluteFolder(valueAfter(words, ["--cwd", "--cd"])),
  };
}

/** How a provider's process was started, read from its command line. */
export function headlessRun(agent: LineageAgent, command: string): HeadlessRun {
  const words = argumentsAfter(agent, command);
  if (!words) return { headless: false, resume: false };
  if (agent === "codex") return codexRun(words);
  if (agent === "claude") return promptRun(words, ["-p", "--print"], ["--resume", "-r", "--continue", "-c"]);
  return promptRun(words, ["-p", "--prompt", "--print"], ["--resume", "--continue"]);
}

/** One command of a shell line: a pipeline stage, a list item, a subshell. */
const SEGMENTS = /[;&|\n()]|\$\(|`/;

/** Tools that look for or stop processes: a provider's command line quoted to them starts nothing. */
const SEARCHES = new Set(["pgrep", "pkill", "killall", "grep", "egrep", "fgrep", "rg", "ps", "lsof"]);

/** Whether the quoted text at `at` is an argument of `pgrep -f "codex exec …"` or the like. */
function searched(text: string, at: number): boolean {
  const segment = text.slice(Math.max(0, at - 1_024), at).split(SEGMENTS).pop() ?? "";
  return SEARCHES.has(leaf(segment.trim().split(/\s+/)[0] ?? ""));
}

/**
 * The providers a shell command starts headless, as a chat wrote it. Only the provider's own word
 * counts (`codex`, `/opt/homebrew/bin/codex`), never a folder that carries its name, nor a command
 * line a chat looks for (`pgrep -f "codex exec"`).
 */
export function headlessTargets(command: string): LineageAgent[] {
  const found = new Set<LineageAgent>();
  const text = command.slice(0, 16_384);
  const quoted = /"(?:[^"\\]|\\.)*"|'[^']*'/g;
  // A quoted request is one word to the shell, however many flags its text mentions; a quoted command
  // (`bash -lc "…"`, a code-mode call's string) is read as the command it is.
  const inner = [...text.matchAll(quoted)].slice(0, 64).filter((match) => !searched(text, match.index))
    .map((match) => match[0].slice(1, -1).replace(/\\(["\\$`])/g, "$1"));
  for (const line of [text, ...inner.filter((item) => /claude|codex|grok|cursor/i.test(item))]) {
    const words = line.replace(quoted, (item) => /\s/.test(item) ? " Q " : item);
    for (const segment of words.split(SEGMENTS)) {
      if (!/claude|codex|grok|cursor/i.test(segment) || SEARCHES.has(leaf(segment.trim().split(/\s+/)[0] ?? ""))) continue;
      for (const agent of AGENTS) {
        const run = headlessRun(agent, segment);
        if (run.headless && !run.resume) found.add(agent);
      }
    }
  }
  return [...found];
}

/**
 * Text in one spelling, for finding a request inside the command that carried it: shell and string
 * quoting and escapes dropped, whitespace collapsed.
 */
export function lineageText(text: string): string {
  return text.replace(/\\[nrt]/g, " ").replace(/\\([\s\S])/g, "$1").replace(/["'`]/g, "").replace(/\s+/g, " ").trim();
}

/** A request shorter than this says too little to be found in another chat's command. */
export const MIN_PROMPT_CHARS = 40;
/** How much of a request is kept and must be found: a script that fills a template keeps its opening. */
export const PROMPT_LEAD_CHARS = 64;

export type PromptLead = { lead: string; length: number };

/** The opening of a session's first request, in `lineageText` spelling, when it is long enough to match. */
export function promptLead(text: string | undefined): PromptLead | undefined {
  if (!text) return undefined;
  const plain = lineageText(text.slice(0, 4_000));
  return plain.length >= MIN_PROMPT_CHARS ? { lead: plain.slice(0, PROMPT_LEAD_CHARS), length: plain.length } : undefined;
}
