import { homedir } from "node:os";
import type { AgentDiskUsage, WorkstationSpace } from "../../../../packages/protocol/schema";
import type { EngineWorkstationGroup, EngineWorkstationSpace } from "../engine/protocol/engine-protocol";
import { AGENT_LOCATIONS, displayPath, measureAgentDisk } from "../machine-load/host/disk-usage";
import type { WorkstationEngine } from "./engine";
import { homeDiskSpace } from "./load";
import { readSpace, writeSpace } from "./settings";

export type ScanTrigger = WorkstationSpace["trigger"];
type Group = WorkstationSpace["groups"][number];
type Item = Group["items"][number];

const SECTIONS = new Set<Group["section"]>(["agents", "projects", "caches", "models", "data", "system"]);
const KINDS = new Set<Item["kind"]>(["regenerable", "history", "protected", "context", "user-data", "inspect"]);
/** A person who asked waits longer than a measurement nobody is watching. */
const BUDGET_MS: Record<ScanTrigger, number> = {
  manual: 180_000, agent: 180_000, daily: 120_000, "low-space": 120_000, "space-drop": 120_000,
};

let running: Promise<WorkstationSpace | undefined> | undefined;

export function spaceScanRunning(): boolean { return running != null; }

/** One measurement at a time per process; the Engine also refuses a second one across processes. */
export function scanSpace(
  trigger: ScanTrigger, engine: WorkstationEngine,
  options: { now?: () => number; home?: string; directory?: string } = {},
): Promise<WorkstationSpace | undefined> {
  running ??= measure(trigger, engine, options).finally(() => { running = undefined; });
  return running;
}

async function measure(
  trigger: ScanTrigger, engine: WorkstationEngine,
  options: { now?: () => number; home?: string; directory?: string },
): Promise<WorkstationSpace | undefined> {
  const now = options.now ?? Date.now;
  const home = options.home ?? homedir();
  const answer = await engine.space(BUDGET_MS[trigger]);
  if (answer === "busy") return readSpace(options.directory);
  const report = typeof answer === "object"
    ? fromEngine(answer, trigger, home)
    : await agentFolders(trigger, home, now);
  if (!report) return readSpace(options.directory);
  const disk = homeDiskSpace(home);
  const measured: WorkstationSpace = { ...report, ...(disk ? { diskAvailableBytes: disk.availableBytes } : {}) };
  writeSpace(measured, options.directory);
  return measured;
}

export function fromEngine(space: EngineWorkstationSpace, trigger: ScanTrigger, home: string): WorkstationSpace {
  return {
    scannedAt: space.started_at_ms, durationMs: space.duration_ms, complete: space.complete,
    trigger, source: "engine",
    groups: space.groups.flatMap((group) => wireGroup(group, home)).slice(0, 16),
  };
}

function wireGroup(group: EngineWorkstationGroup, home: string): Group[] {
  const section = group.section as Group["section"];
  if (!SECTIONS.has(section)) return [];
  const items = group.items.flatMap((item): Item[] => {
    const title = item.title.trim().slice(0, 160), path = displayPath(item.path, home).slice(0, 240);
    if (!title || !path) return [];
    const kind = KINDS.has(item.kind as Item["kind"]) ? item.kind as Item["kind"] : "inspect";
    return [{ title, path, bytes: item.bytes, kind, ...(item.partial ? { partial: true } : {}) }];
  }).slice(0, 6);
  const id = group.id.trim().slice(0, 80), title = group.title.trim().slice(0, 80);
  if (!id || !title) return [];
  return [{ id, title, section, bytes: group.bytes, regenerableBytes: group.regenerable_bytes,
    ...(group.partial ? { partial: true } : {}), items }];
}

/** Without the Engine: only the coding agents' own folders, measured with `du`. */
async function agentFolders(trigger: ScanTrigger, home: string, now: () => number): Promise<WorkstationSpace | undefined> {
  const started = now();
  const groups: Group[] = [];
  for (const agent of Object.keys(AGENT_LOCATIONS)) {
    const usage = await measureAgentDisk(agent, { home, now });
    if (!usage || usage.totalBytes === 0) continue;
    const items = usage.entries.filter((entry) => entry.path !== "…").slice(0, 6)
      .map((entry): Item => ({ title: entry.path.split("/").pop() || entry.path, path: entry.path.slice(0, 240),
        bytes: entry.bytes, kind: folderKind(entry.path) }));
    groups.push({ id: `agent:${agent}`, title: AGENT_TITLES[agent] ?? agent, section: "agents",
      bytes: usage.totalBytes, regenerableBytes: items.filter((item) => item.kind === "regenerable")
        .reduce((sum, item) => sum + item.bytes, 0), items });
  }
  if (groups.length === 0) return undefined;
  groups.sort((left, right) => right.bytes - left.bytes);
  return { scannedAt: started, durationMs: Math.max(0, now() - started), complete: true, trigger,
    source: "folders", groups };
}

const AGENT_TITLES: Record<string, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", grok: "Grok" };

/** The same name rules the Engine's classifier starts from, for the folders `du` can name. */
export function folderKind(path: string): Item["kind"] {
  const name = (path.split("/").pop() ?? "").toLowerCase();
  if (/^(projects|sessions|archived_sessions|history|history\.jsonl|transcripts)$/.test(name)) return "history";
  if (/(^|[^a-z])(cache|caches|tmp|temp|logs?)([^a-z]|$)/.test(name) || name === "claude-cli-nodejs") return "regenerable";
  if (/credential|secret|auth\.json|\.sqlite|\.db$/.test(name)) return "protected";
  if (/^(skills|plugins|rules|agents\.md)$/.test(name)) return "context";
  return "inspect";
}

/** The agents' folders as the load sheet shows them, from the last summary rather than a fresh `du`. */
export function agentDiskFromSpace(space: WorkstationSpace | undefined): Record<string, AgentDiskUsage> {
  const out: Record<string, AgentDiskUsage> = {};
  for (const group of space?.groups ?? []) {
    const agent = group.id.startsWith("agent:") ? group.id.slice(6) : "";
    if (!(agent in AGENT_LOCATIONS)) continue;
    const entries = group.items.map((item) => ({ path: item.path, bytes: item.bytes }));
    const rest = group.bytes - entries.reduce((sum, entry) => sum + entry.bytes, 0);
    if (rest > 0) entries.push({ path: "…", bytes: rest });
    out[agent] = { measuredAt: space!.scannedAt, totalBytes: group.bytes, entries };
  }
  return out;
}
