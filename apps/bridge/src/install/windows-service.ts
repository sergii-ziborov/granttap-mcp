/** Per-user Windows Task Scheduler jobs for the loopback MCP and phone monitor. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "../config";
import type { InstallResult } from ".";

export type WindowsJob = "http" | "monitor";
const names: Record<WindowsJob, string> = {
  http: "GrantTap MCP HTTP",
  monitor: "GrantTap Phone Monitor",
};

export function windowsTaskName(job: WindowsJob): string { return names[job]; }

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function parentDir(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index <= 0 ? "." : path.slice(0, index);
}

export function windowsTaskDefinition(job: WindowsJob, node: string, launcher: string, owner = "TestUser", version = "0.0.0"): string {
  const date = new Date(Date.now() - 60_000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  const start = local.toISOString().slice(0, 19);
  const args = `"${launcher}" internal ${job === "http" ? "serve" : "monitor"}`;
  const workingDirectory = parentDir(parentDir(launcher));
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    `<RegistrationInfo><Description>GrantTap ${xml(version)} ${job}</Description></RegistrationInfo>`,
    "<Triggers><TimeTrigger>", `<StartBoundary>${start}</StartBoundary>`,
    "<Enabled>true</Enabled><Repetition><Interval>PT1M</Interval></Repetition>",
    "</TimeTrigger></Triggers>",
    `<Principals><Principal id="Author"><UserId>${xml(owner)}</UserId>`,
    "<LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>",
    "<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "<StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "<RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>",
    "</Settings>",
    `<Actions Context="Author"><Exec><Command>${xml(node)}</Command>`,
    `<Arguments>${xml(args)}</Arguments><WorkingDirectory>${xml(workingDirectory)}</WorkingDirectory>`,
    "</Exec></Actions></Task>", "",
  ].join("\n");
}

function taskXml(job: WindowsJob): string | null {
  const result = spawnSync("schtasks.exe", ["/Query", "/TN", names[job], "/XML"], { windowsHide: true });
  if (result.status !== 0) return null;
  const output = result.stdout;
  return output[0] === 0xff && output[1] === 0xfe || output.includes(0)
    ? output.toString("utf16le").replace(/^\uFEFF/, "")
    : output.toString("utf8");
}

function owned(job: WindowsJob, data: string): boolean {
  return /<Command>[^<]*node\.exe<\/Command>/i.test(data)
    && /granttap-mcp\.mjs(?:&quot;|\")? internal (?:serve|monitor)/i.test(data)
    && data.includes(`internal ${job === "http" ? "serve" : "monitor"}`);
}

function identity(): string | null {
  const result = spawnSync("whoami.exe", [], { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

function taskFile(job: WindowsJob): string { return join(configDir(), `windows-${job}-task.xml`); }

export function inspectWindowsTask(job: WindowsJob): { configured: boolean; running: boolean } {
  const data = taskXml(job);
  if (!data || !owned(job, data)) return { configured: false, running: false };
  const state = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    `(Get-ScheduledTask -TaskName '${names[job]}').State.ToString()`,
  ], { encoding: "utf8", windowsHide: true });
  return { configured: true, running: state.status === 0 && state.stdout.trim() === "Running" };
}

export function installWindowsTask(job: WindowsJob, node: string, launcher: string, forceReload = false): InstallResult {
  if (!existsSync(node) || !existsSync(launcher)) {
    return { status: "manual", detail: "Stable Node.js and granttap-mcp installation are required on Windows." };
  }
  const previous = taskXml(job);
  if (previous && !owned(job, previous)) {
    return { status: "manual", detail: `The existing ${names[job]} task is not owned by GrantTap.` };
  }
  const owner = identity();
  if (!owner) return { status: "manual", detail: "Could not identify the current Windows user." };
  let version: string;
  try {
    version = (JSON.parse(readFileSync(join(dirname(launcher), "..", "package.json"), "utf8")) as { version: string }).version;
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("invalid version");
  } catch {
    return { status: "manual", detail: "Installed GrantTap package version could not be read." };
  }
  const path = taskFile(job);
  const definition = windowsTaskDefinition(job, node, launcher, owner, version);
  const previousCommand = previous?.match(/<Command>([^<]*)<\/Command>/)?.[1];
  const previousArgs = previous?.match(/<Arguments>([^<]*)<\/Arguments>/)?.[1];
  const normalizedArgs = previousArgs?.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
  const already = previousCommand === xml(node)
    && normalizedArgs === `"${launcher}" internal ${job === "http" ? "serve" : "monitor"}`
    && previous?.includes("<Interval>PT1M</Interval>") === true
    && previous.includes(`<Description>GrantTap ${version} ${job}</Description>`);
  if (already && !forceReload && inspectWindowsTask(job).running) return { status: "already", detail: names[job] };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Task Scheduler reads an XML file; keep it private to this user's config directory.
  writeFileSync(path, `\uFEFF${definition}`, { encoding: "utf16le", mode: 0o600 });
  const created = spawnSync("schtasks.exe", ["/Create", "/TN", names[job], "/XML", path, "/F"], {
    encoding: "utf8", windowsHide: true,
  });
  unlinkSync(path);
  if (created.status !== 0) return { status: "manual", detail: `${names[job]} could not be registered for this Windows user.` };
  if (previous && (forceReload || !already)) {
    spawnSync("schtasks.exe", ["/End", "/TN", names[job]], { windowsHide: true });
  }
  const started = spawnSync("schtasks.exe", ["/Run", "/TN", names[job]], { encoding: "utf8", windowsHide: true });
  return started.status === 0
    ? { status: already ? "already" : "installed", detail: names[job] }
    : { status: "manual", detail: `${names[job]} was registered but did not start.` };
}

export function snapshotWindowsTask(job: WindowsJob): string | null { return taskXml(job); }

export function restoreWindowsTask(job: WindowsJob, previous: string | null): boolean {
  const current = taskXml(job);
  if (!current || !owned(job, current) || (previous && !owned(job, previous))) return false;
  spawnSync("schtasks.exe", ["/End", "/TN", names[job]], { windowsHide: true });
  if (!previous) return spawnSync("schtasks.exe", ["/Delete", "/TN", names[job], "/F"], { windowsHide: true }).status === 0;
  const path = taskFile(job);
  writeFileSync(path, `\uFEFF${previous}`, { encoding: "utf16le", mode: 0o600 });
  const restored = spawnSync("schtasks.exe", ["/Create", "/TN", names[job], "/XML", path, "/F"], { windowsHide: true });
  unlinkSync(path);
  return restored.status === 0 && spawnSync("schtasks.exe", ["/Run", "/TN", names[job]], { windowsHide: true }).status === 0;
}
