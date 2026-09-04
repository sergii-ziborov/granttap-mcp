/**
 * Keeping the coding agents' command-line tools current, from the phone.
 *
 * A tool that lags the rest of the environment fails in ways the phone can
 * only report — a chat the app wrote that an older Claude Code cannot resume.
 * The phone may ask for the fix, but it chooses only which tool; the command
 * is the helper's, fixed by how that tool was installed: the tool's own
 * updater, the npm that owns its prefix, or Homebrew. Nothing is fetched by
 * hand, and a tool installed by a script the helper would have to re-run is
 * left to a trusted terminal, with the command spelled out.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { CodingAgent } from "../../../../packages/protocol/schema";
import { compareVersions, executableOnPath, resolveClaudeBinary } from "../claude-bin";
import { resolveCursorAgentBin } from "../reply/cursor-agent-bin";
import { askVersion, binaryVersion, forgetVersion, stripAnsi } from "./version";

export const TOOL_NAMES: Record<CodingAgent, string> = {
  claude: "Claude Code", codex: "Codex CLI", cursor: "Cursor CLI", grok: "Grok CLI",
};
export const AGENTS: CodingAgent[] = ["claude", "codex", "cursor", "grok"];

export type ToolMethod = "native" | "npm" | "brew" | "desktop" | "unknown";
export type ToolInstall = { method: ToolMethod; npmPrefix?: string; npmPackage?: string };

export type ToolStatus = {
  agent: CodingAgent;
  /** The executable the helper runs, when one was found. */
  path?: string;
  /** The version that answers on this computer. */
  version?: string;
  method: ToolMethod;
  /** The tool's own updater, as argv, when one applies. */
  update?: string[];
  /** A newer copy already on this disk, which the helper already uses. */
  newerOnThisMac?: string;
};

export type ToolUpdateOutcome = {
  ok: boolean;
  before?: string;
  after?: string;
  command?: string;
  message: string;
  output?: string;
};

const UPDATE_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT = 4_000;

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** How a resolved executable got there, read from its path alone. */
export function installMethod(resolvedPath: string): ToolInstall {
  const marker = "/node_modules/";
  const at = resolvedPath.indexOf(marker);
  if (at >= 0) {
    const rest = resolvedPath.slice(at + marker.length).split("/");
    const npmPackage = rest[0]?.startsWith("@") ? `${rest[0]}/${rest[1] ?? ""}` : rest[0];
    const lib = resolvedPath.slice(0, at);
    const npmPrefix = basename(lib) === "lib" ? dirname(lib) : lib;
    return { method: "npm", npmPrefix, npmPackage: npmPackage || undefined };
  }
  if (/\/(Cellar|Caskroom|Homebrew)\//.test(resolvedPath) || resolvedPath.startsWith("/opt/homebrew/")) {
    return { method: "brew" };
  }
  if (resolvedPath.includes("/.local/share/claude/versions/")) return { method: "native" };
  if (resolvedPath.includes("/Application Support/Claude/claude-code/")) return { method: "desktop" };
  return { method: "unknown" };
}

function resolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function npmArgv(install: ToolInstall, fallbackPackage: string, env: NodeJS.ProcessEnv): string[] | undefined {
  const own = install.npmPrefix ? join(install.npmPrefix, "bin", "npm") : undefined;
  const npm = own && executable(own) ? own : executableOnPath("npm", env);
  return npm ? [npm, "install", "-g", `${install.npmPackage ?? fallbackPackage}@latest`] : undefined;
}

function brewArgv(cask: string, env: NodeJS.ProcessEnv): string[] | undefined {
  const brew = executableOnPath("brew", env);
  return brew ? [brew, "upgrade", "--cask", cask] : undefined;
}

/** The updater for one tool, or nothing when the helper should not be the one to run it. */
export function updateArgv(
  agent: CodingAgent,
  path: string | undefined,
  install: ToolInstall,
  env: NodeJS.ProcessEnv = process.env,
): string[] | undefined {
  switch (agent) {
    case "claude":
      if (install.method === "npm") return npmArgv(install, "@anthropic-ai/claude-code", env);
      if (install.method === "brew") return brewArgv("claude-code", env);
      if (install.method === "desktop") return undefined;
      return path ? [path, "update"] : undefined;
    case "codex":
      if (install.method === "npm") return npmArgv(install, "@openai/codex", env);
      if (install.method === "brew") return brewArgv("codex", env);
      return undefined;
    case "cursor":
    case "grok":
      return path ? [path, "update"] : undefined;
  }
}

function locate(agent: CodingAgent, env: NodeJS.ProcessEnv): string | undefined {
  switch (agent) {
    case "claude": return env.GRANTTAP_CLAUDE_BIN ?? env.NODVOX_CLAUDE_BIN ?? executableOnPath("claude", env);
    case "codex": return env.GRANTTAP_CODEX_BIN ?? env.NODVOX_CODEX_BIN ?? executableOnPath("codex", env);
    case "cursor": {
      const bin = resolveCursorAgentBin(env);
      return bin.includes("/") ? (executable(bin) ? bin : undefined) : executableOnPath(bin, env);
    }
    case "grok": return env.GRANTTAP_GROK_BIN ?? executableOnPath("grok", env);
  }
}

export function inspectTool(
  agent: CodingAgent,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): ToolStatus {
  const path = locate(agent, env);
  const install = path ? installMethod(resolved(path)) : { method: "unknown" as const };
  const own = path ? binaryVersion(path) : undefined;
  const status: ToolStatus = {
    agent, path, version: own, method: install.method, update: updateArgv(agent, path, install, env),
  };
  if (agent === "claude") {
    // The helper answers with the newest Claude Code on the disk, which may
    // not be the one `claude update` would replace.
    const answering = resolveClaudeBinary(home, env);
    if (answering.version) {
      status.version = answering.version;
      if (own && compareVersions(answering.version, own) > 0) status.newerOnThisMac = answering.version;
    }
  }
  return status;
}

export function inspectTools(env: NodeJS.ProcessEnv = process.env, home = homedir()): ToolStatus[] {
  return AGENTS.map((agent) => inspectTool(agent, env, home));
}

/** The command as the phone shows it: the binary by name, the arguments as run. */
export function describeCommand(argv: string[]): string {
  return [basename(argv[0] ?? ""), ...argv.slice(1)].join(" ");
}

/** Why the helper will not run an update for this tool, and what will. */
export function manualHint(agent: CodingAgent, status: ToolStatus): string {
  const name = TOOL_NAMES[agent];
  if (!status.path) return `${name} is not installed on this computer.`;
  if (status.method === "desktop") return `${name} here is the Claude app's own copy; the app keeps it current.`;
  if (agent === "codex") {
    return `${name} was installed by its installer script, so GrantTap will not replace it. `
      + "In a trusted terminal: curl -fsSL https://chatgpt.com/codex/install.sh | sh";
  }
  return `${name} cannot be updated by GrantTap on this computer; update it from a trusted terminal.`;
}

const running = new Map<CodingAgent, Promise<ToolUpdateOutcome>>();

export function updatingTools(): CodingAgent[] {
  return [...running.keys()];
}

export type UpdateRunner = (argv: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number)
  => Promise<{ code: number | null; output: string; error?: string }>;

const runUpdater: UpdateRunner = (argv, env, cwd, timeoutMs) => new Promise((resolve) => {
  let child;
  try {
    child = spawn(argv[0]!, argv.slice(1), {
      cwd, env: { ...env, NO_COLOR: "1", CI: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    resolve({ code: null, output: "", error: (error as Error).message });
    return;
  }
  let output = "";
  let done = false;
  const keep = (chunk: unknown): void => {
    output = (output + String(chunk)).slice(-MAX_OUTPUT * 4);
  };
  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    child.kill("SIGKILL");
    resolve({ code: null, output, error: `did not finish within ${Math.round(timeoutMs / 60_000)} minutes` });
  }, timeoutMs);
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  child.on("error", (error) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    resolve({ code: null, output, error: error.message });
  });
  child.on("close", (code) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    resolve({ code, output });
  });
});

/** Run one tool's own updater and say what changed. One run per tool at a time. */
export function updateTool(
  agent: CodingAgent,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  runner: UpdateRunner = runUpdater,
  timeoutMs = UPDATE_TIMEOUT_MS,
): Promise<ToolUpdateOutcome> {
  const name = TOOL_NAMES[agent];
  if (running.has(agent)) {
    return Promise.resolve({ ok: false, message: `${name} is already being updated on this computer.` });
  }
  const status = inspectTool(agent, env, home);
  if (!status.update) {
    return Promise.resolve({ ok: false, before: status.version, message: manualHint(agent, status) });
  }
  const argv = status.update;
  const command = describeCommand(argv);
  const task = (async (): Promise<ToolUpdateOutcome> => {
    const before = status.version;
    const result = await runner(argv, env, home, timeoutMs);
    forgetVersion();
    // The updater just ran the tool; asking it its version now adds nothing new.
    const updated = inspectTool(agent, env, home);
    const after = updated.version ?? (updated.path ? askVersion(updated.path) : undefined);
    const output = stripAnsi(result.output).trim().slice(-MAX_OUTPUT) || undefined;
    if (result.error || result.code !== 0) {
      const why = result.error ?? `exited with code ${result.code}`;
      return { ok: false, before, after, command, output, message: `${name} update failed: ${why}.` };
    }
    const message = before && after && before !== after
      ? `${name} updated from ${before} to ${after}.`
      : !before && after
        ? `${name} is now ${after}.`
        : `${name} is up to date${after ? ` (${after})` : ""}.`;
    return { ok: true, before, after, command, output, message };
  })().finally(() => running.delete(agent));
  running.set(agent, task);
  return task;
}
