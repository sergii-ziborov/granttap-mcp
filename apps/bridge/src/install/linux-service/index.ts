import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { configDir } from "../../config";
import type { InstallResult } from "../inspect";
import { linuxServiceDefinition, linuxServiceName, ownedLinuxService, type LinuxJob } from "./definition";

export { linuxServiceDefinition, linuxServiceName } from "./definition";
export type LinuxServiceOptions = {
  directory?: string; configDirectory?: string; uid?: number; forceReload?: boolean;
  command?: (args: string[]) => { status: number | null };
};

export function linuxServicePath(job: LinuxJob, directory = join(homedir(), ".config", "systemd", "user")): string {
  return join(directory, linuxServiceName(job));
}

function command(args: string[]): { status: number | null } {
  return spawnSync("/usr/bin/systemctl", ["--user", ...args], { stdio: "ignore", timeout: 10_000 });
}

function readOwned(job: LinuxJob, path: string): string | null {
  let metadata;
  try { metadata = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Refusing a linked Linux service unit");
  const contents = readFileSync(path, "utf8");
  if (!ownedLinuxService(contents, job)) throw new Error("The existing service unit is not owned by GrantTap");
  return contents;
}

export type LinuxServiceSnapshot = { definition: string | null; exists: boolean; owned: boolean; enabled: boolean; running: boolean };

export function snapshotLinuxService(job: LinuxJob): LinuxServiceSnapshot {
  const name = linuxServiceName(job);
  try {
    const definition = readOwned(job, linuxServicePath(job));
    return { definition, exists: definition !== null, owned: definition !== null,
      enabled: definition !== null && command(["is-enabled", "--quiet", name]).status === 0,
      running: definition !== null && command(["is-active", "--quiet", name]).status === 0 };
  } catch { return { definition: null, exists: true, owned: false, enabled: false, running: false }; }
}

export function restoreLinuxService(job: LinuxJob, before: LinuxServiceSnapshot): boolean {
  const path = linuxServicePath(job), name = linuxServiceName(job);
  if (before.exists && (!before.owned || !before.definition || !ownedLinuxService(before.definition, job))) return false;
  try {
    readOwned(job, path);
    command(["stop", name]);
    if (before.definition) { writeUnit(path, before.definition); command([before.enabled ? "enable" : "disable", name]); }
    else { command(["disable", name]); if (existsSync(path)) unlinkSync(path); }
    if (command(["daemon-reload"]).status !== 0) return false;
    return !before.running || command(["start", name]).status === 0;
  } catch { return false; }
}

export function inspectLinuxService(job: LinuxJob): { configured: boolean; running: boolean } {
  try {
    const configured = readOwned(job, linuxServicePath(job)) !== null;
    return { configured, running: configured && command(["is-active", "--quiet", linuxServiceName(job)]).status === 0 };
  } catch { return { configured: false, running: false }; }
}

function writeUnit(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  try { writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" }); renameSync(temporary, path); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

/** Uses the existing unprivileged user manager; never enables lingering or changes system units. */
export function installLinuxService(job: LinuxJob, node: string, launcher: string, options: LinuxServiceOptions = {}): InstallResult {
  if ((options.uid ?? process.getuid?.()) === 0) return { status: "manual", detail: "Install GrantTap as your regular Linux user." };
  const path = linuxServicePath(job, options.directory), name = linuxServiceName(job);
  const run = options.command ?? command;
  let before: string | null;
  let definition: string;
  try {
    accessSync(node, constants.X_OK); accessSync(launcher, constants.R_OK);
    if (launcher.replaceAll("\\", "/").includes("/_npx/")) throw new Error("A stable GrantTap installation is required");
    before = readOwned(job, path);
    const version: unknown = JSON.parse(readFileSync(join(dirname(launcher), "..", "package.json"), "utf8")).version;
    if (typeof version !== "string") throw new Error("Installed GrantTap version is missing");
    definition = linuxServiceDefinition(job, node, launcher, options.configDirectory ?? configDir(), version);
  } catch { return { status: "manual", detail: "Linux service needs a stable installation and an owned regular unit file." }; }
  const running = before !== null && run(["is-active", "--quiet", name]).status === 0;
  const enabled = before !== null && run(["is-enabled", "--quiet", name]).status === 0;
  if (before === definition && running && !options.forceReload) return { status: "already", detail: name };
  try {
    writeUnit(path, definition);
    for (const args of [["daemon-reload"], ["enable", name], ["restart", name]]) {
      if (run(args).status !== 0) throw new Error("User service manager is unavailable");
    }
    return { status: before === definition ? "already" : "installed", detail: name };
  } catch {
    try {
      run(["stop", name]);
      if (before === null) { run(["disable", name]); if (existsSync(path)) unlinkSync(path); }
      else { writeUnit(path, before); run([enabled ? "enable" : "disable", name]); }
      run(["daemon-reload"]); if (running) run(["start", name]);
    } catch { /* Keep a failed repair explicit even when its rollback cannot reach systemd. */ }
    return { status: "manual", detail: "GrantTap could not start its per-user Linux service. Check the user systemd session and retry setup." };
  }
}
