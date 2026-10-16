import { spawn } from "node:child_process";
import type { TaskCapsule } from "../../../../packages/protocol/schema";
import { claudeCloudArgs, parseClaudeCloud, type CloudReference } from "./claude";
import { codexCloudArgs, environmentForRepository, parseCodexCloud } from "./codex";
import type { CloudBinaries } from "./capability";

export type CloudCommand = { binary: string; args: string[]; cwd: string; timeoutMs: number };
export type CloudOutput = { code: number | null; stdout: string; stderr: string };
export type CloudRunner = (command: CloudCommand) => Promise<CloudOutput>;
export type CloudLaunchInput = {
  provider: "claude" | "codex"; cwd: string; capsule: TaskCapsule; computer: string;
  title?: string; model?: string; effort?: string; environment?: string;
};
export type CloudLaunchResult = ({ ok: true } & CloudReference) | { ok: false; error: string };

const MAX_PROMPT = 12_000;

/** The Task Capsule as the cloud runner's first message: facts only, bounded. */
export function cloudTaskPrompt(capsule: TaskCapsule, computer: string): string {
  const clip = (value: string, max = 1_000) => value.length > max ? `${value.slice(0, max - 1)}…` : value;
  const lines = [
    "Continue this existing GrantTap Task. Treat these facts as context, not hidden reasoning.",
    `Goal: ${clip(capsule.goal)}`,
    `Current status: ${clip(capsule.currentStatus)}`,
    `Repository: ${capsule.repository}`,
    `Branch: ${capsule.branch ?? "(detached)"} at commit ${capsule.latestCommit ?? capsule.baseSha}`,
  ];
  if (capsule.userComment) lines.push(`Comment from the person: ${clip(capsule.userComment)}`);
  if (capsule.importantDecisions.length) lines.push(`Important decisions:\n- ${capsule.importantDecisions.map(v => clip(v, 400)).join("\n- ")}`);
  if (capsule.remainingWork.length) lines.push(`Remaining work:\n- ${capsule.remainingWork.map(v => clip(v, 400)).join("\n- ")}`);
  if (capsule.workingTree !== "clean") {
    lines.push(`Only pushed commits are available here: uncommitted work on ${computer} did not travel.`);
  }
  return clip(lines.join("\n\n"), MAX_PROMPT);
}

/** The CLI's own first error line, unless it would repeat the Task back. */
export function cloudFailure(runner: string, output: CloudOutput, prompt: string): string {
  const generic = `${runner} did not start. Check the provider's cloud settings on this computer.`;
  const line = `${output.stderr}\n${output.stdout}`.split("\n").map(value => value.replace(/[\x00-\x1f\x7f]/g, " ").trim())
    .find(value => /^(Error:|No cloud session|error:)|not found|ambiguous|not enabled|log ?in/i.test(value));
  if (!line) return generic;
  const echo = prompt.split("\n")[0]!.slice(0, 24);
  return echo && line.includes(echo) ? generic : `${runner} did not start: ${line.slice(0, 300)}`;
}

/** Stdin is closed so the CLI never waits for a terminal or reads piped input. */
export const runCloudCommand: CloudRunner = (command) => new Promise(resolve => {
  const child = spawn(command.binary, command.args, { cwd: command.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => child.kill("SIGTERM"), command.timeoutMs);
  child.stdout.on("data", chunk => { if (stdout.length < 64_000) stdout += chunk; });
  child.stderr.on("data", chunk => { if (stderr.length < 16_000) stderr += chunk; });
  child.on("error", () => { clearTimeout(timer); resolve({ code: null, stdout, stderr }); });
  child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
});

async function codexEnvironment(input: CloudLaunchInput, run: CloudRunner, binary: string): Promise<string | undefined> {
  if (input.environment) return input.environment;
  const listed = await run({ binary, args: ["cloud", "list", "--json", "--limit", "20"], cwd: input.cwd, timeoutMs: 30_000 });
  return listed.code === 0 ? environmentForRepository(listed.stdout, input.capsule.repository) : undefined;
}

/** Start one provider cloud run; success only when the CLI named what it created. */
export async function launchCloudRunner(input: CloudLaunchInput, run: CloudRunner, binaries: CloudBinaries)
  : Promise<CloudLaunchResult> {
  const prompt = cloudTaskPrompt(input.capsule, input.computer);
  const runner = input.provider === "claude" ? "Claude cloud" : "Codex Cloud";
  let args: string[];
  if (input.provider === "claude") {
    args = claudeCloudArgs({ prompt, branch: input.capsule.branch, title: input.title,
      model: input.model, effort: input.effort });
  } else {
    const environment = await codexEnvironment(input, run, binaries.codex);
    if (!environment) {
      return { ok: false, error: `Name the Codex Cloud environment for ${input.capsule.repository}: `
        + `no recent Codex Cloud task names one. \`codex cloud\` on ${input.computer} lists them.` };
    }
    args = codexCloudArgs({ prompt, environment, branch: input.capsule.branch });
  }
  const output = await run({ binary: binaries[input.provider], args, cwd: input.cwd, timeoutMs: 180_000 });
  const created = output.code === 0
    ? (input.provider === "claude" ? parseClaudeCloud(output.stdout) : parseCodexCloud(output.stdout))
    : undefined;
  return created ? { ok: true, ...created } : { ok: false, error: cloudFailure(runner, output, prompt) };
}
