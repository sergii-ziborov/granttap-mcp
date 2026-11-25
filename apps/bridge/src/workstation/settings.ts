import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkstationSettings, WorkstationSpace } from "../../../../packages/protocol/schema";
import { configDir } from "../config/runtime/paths";

export const DEFAULT_SETTINGS: WorkstationSettings = { automaticScan: "smart", lowSpaceAlert: true };

/** Owner-only folder shared by the monitor and the MCP servers of this computer. */
export function workstationDir(): string {
  return join(configDir(), "workstation");
}

export function readSettings(directory = workstationDir()): WorkstationSettings {
  const parsed = WorkstationSettings.safeParse(readJson(join(directory, "settings.json")));
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export function writeSettings(settings: WorkstationSettings, directory = workstationDir()): void {
  writeJson(join(directory, "settings.json"), WorkstationSettings.parse(settings));
}

/** The last space summary, kept so a phone or agent sees it after a restart. */
export function readSpace(directory = workstationDir()): WorkstationSpace | undefined {
  const parsed = WorkstationSpace.safeParse(readJson(join(directory, "space.json")));
  return parsed.success ? parsed.data : undefined;
}

export function writeSpace(space: WorkstationSpace, directory = workstationDir()): void {
  writeJson(join(directory, "space.json"), WorkstationSpace.parse(space));
}

/** The most severe low-space level already told to the phone, so a restart does not repeat it. */
export function readAlerted(directory = workstationDir()): "ok" | "low" | "critical" {
  const value = (readJson(join(directory, "alert.json")) as { alerted?: unknown } | undefined)?.alerted;
  return value === "low" || value === "critical" ? value : "ok";
}

export function writeAlerted(alerted: "ok" | "low" | "critical", directory = workstationDir()): void {
  writeJson(join(directory, "alert.json"), { alerted });
}

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value) + "\n", { mode: 0o600 });
  renameSync(temporary, path);
}
