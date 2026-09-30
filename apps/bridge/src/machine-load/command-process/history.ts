/** Short-lived OS samples used to measure a CLI call without asking the agent. */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CapabilityResourceUsage } from "../../../../../packages/protocol/messages/capabilities";
import { configDir } from "../../config/runtime/paths";
import { commandTextFromInput } from "../../sessions/telemetry/command-preview";

export type CommandProcessRow = {
  pid: number;
  ppid?: number;
  agent: string;
  sessionId?: string;
  command: string;
  cpuTimeMs?: number;
  elapsedMs?: number;
  rssBytes: number;
};

type SampledProcess = Omit<CommandProcessRow, "command"> & { signatures: Set<string> };
type Sample = { at: number; rows: SampledProcess[] };
const MAX_SAMPLES = 300;
const MAX_CACHE_BYTES = 8_000_000;
const MAX_EDGE_GAP_MS = 2_500;
const MAX_SAMPLE_GAP_MS = 5_000;
const START_TOLERANCE_MS = 2_000;
let samples: Sample[] = [];
let restored: { path: string; size: number; mtimeMs: number; samples: Sample[] } | undefined;

function cachePath(): string {
  return join(configDir(), "command-process-samples.jsonl");
}

function serialized(sample: Sample): string {
  return JSON.stringify({ at: sample.at, rows: sample.rows.map((row) => ({
    ...row, signatures: [...row.signatures],
  })) }) + "\n";
}

function persist(sample: Sample): void {
  try {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    const path = cachePath();
    const line = serialized(sample);
    if (Buffer.byteLength(line) > 256_000) return;
    if (existsSync(path) && statSync(path).size + Buffer.byteLength(line) > MAX_CACHE_BYTES) {
      writeFileSync(path, samples.slice(-120).map(serialized).join(""), { mode: 0o600 });
      return;
    }
    appendFileSync(path, line, { mode: 0o600 });
  } catch {
    // A failed local cache leaves live in-memory measurement intact.
  }
}

function restoredSamples(): Sample[] {
  try {
    const path = cachePath();
    if (!existsSync(path)) return [];
    const stat = statSync(path);
    if (stat.size > MAX_CACHE_BYTES) return [];
    if (restored?.path === path && restored.size === stat.size
      && restored.mtimeMs === stat.mtimeMs) return restored.samples;
    const parsed = readFileSync(path, "utf8").split("\n").slice(-MAX_SAMPLES - 1)
      .flatMap((line): Sample[] => {
        if (!line) return [];
        try {
          const value = JSON.parse(line) as Sample & { rows: Array<SampledProcess & { signatures: string[] }> };
          if (!Number.isFinite(value.at) || !Array.isArray(value.rows) || value.rows.length > 2_000) return [];
          const rows = value.rows.filter((row) => Number.isInteger(row.pid)
            && typeof row.agent === "string" && Number.isFinite(row.rssBytes)
            && Array.isArray(row.signatures) && row.signatures.length <= 300)
            .map((row) => ({ ...row, signatures: new Set(row.signatures) }));
          return [{ at: value.at, rows }];
        } catch { return []; }
      });
    restored = { path, size: stat.size, mtimeMs: stat.mtimeMs, samples: parsed };
    return parsed;
  } catch { return []; }
}

function words(command: string): string[] {
  return command.split(/\s+/).map((part) =>
    part.replace(/^["'()]+|["'(),;]+$/g, "").split("/").pop() ?? ""
  ).filter((part) => part.length > 0 && part !== "--").slice(0, 48);
}

function signature(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);
}

function signatures(command: string): Set<string> {
  const parts = words(command);
  const out = new Set<string>();
  for (let length = 2; length <= Math.min(6, parts.length); length += 1) {
    for (let offset = 0; offset <= parts.length - length; offset += 1) {
      out.add(signature(parts.slice(offset, offset + length)));
    }
  }
  return out;
}

function callSignature(input: unknown): string | undefined {
  const command = commandTextFromInput(input);
  if (!command) return undefined;
  const first = command.split(/\s*(?:&&|\|\||;|\n)\s*/)[0] ?? "";
  const parts = words(first).slice(0, 6);
  return parts.length >= 2 ? signature(parts) : undefined;
}

/** Retain only hashed command fingerprints; command arguments never enter history. */
export function recordCommandProcessSample(
  rows: readonly CommandProcessRow[], at: number, saveForDesktop = false,
): void {
  if (!Number.isFinite(at)) return;
  const sample = { at, rows: rows.map(({ command, ...row }) => ({
    ...row, signatures: signatures(command),
  })) };
  samples.push(sample);
  if (samples.length > MAX_SAMPLES) samples = samples.slice(-MAX_SAMPLES);
  if (saveForDesktop) persist(sample);
}

export function clearCommandProcessHistory(): void {
  samples = [];
}

function tree(rows: readonly SampledProcess[], root: SampledProcess): SampledProcess[] {
  const selected = new Set([root.pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (row.ppid == null || !selected.has(row.ppid) || selected.has(row.pid)) continue;
      selected.add(row.pid);
      grew = true;
    }
  }
  return rows.filter((row) => selected.has(row.pid));
}

function uniqueMatchingTree(
  rows: readonly SampledProcess[],
  matches: readonly SampledProcess[],
): SampledProcess[] | undefined {
  if (matches.length === 0) return undefined;
  const matchingPids = new Set(matches.map((row) => row.pid));
  const containing = matches.map((row) => tree(rows, row))
    .filter((descendants) => descendants.filter((row) => matchingPids.has(row.pid)).length === matches.length);
  if (containing.length !== 1) return undefined;
  return containing[0];
}

/**
 * Attribute CPU and sampled RSS only when one newly-started process matches
 * the call, including its descendants. Ambiguous and undersampled calls stay
 * unknown; agent-wide load is never presented as this command's process tree.
 */
export function commandProcessResource(
  agent: string,
  sessionId: string,
  input: unknown,
  startedAt: number,
  endedAt: number,
): CapabilityResourceUsage | undefined {
  const wanted = callSignature(input);
  if (!wanted || !Number.isFinite(startedAt) || !Number.isFinite(endedAt)
    || endedAt <= startedAt) return undefined;
  const selected: Array<{ at: number; rows: SampledProcess[] }> = [];
  const pids = new Set<number>();
  for (const sample of samples.length > 0 ? samples : restoredSamples()) {
    if (sample.at < startedAt || sample.at > endedAt) continue;
    const matches = sample.rows.filter((row) => row.agent === agent
      && (!row.sessionId || row.sessionId === sessionId)
      && row.signatures.has(wanted)
      && row.elapsedMs != null
      && sample.at - row.elapsedMs >= startedAt - START_TOLERANCE_MS);
    const rows = uniqueMatchingTree(sample.rows, matches);
    if (!rows) continue;
    selected.push({ at: sample.at, rows });
    for (const row of rows) pids.add(row.pid);
  }
  if (selected.length === 0) return undefined;
  if (selected[0]!.at - startedAt > MAX_EDGE_GAP_MS
    || endedAt - selected.at(-1)!.at > MAX_EDGE_GAP_MS) return undefined;
  if (selected.some((sample, index) => index > 0
    && sample.at - selected[index - 1]!.at > MAX_SAMPLE_GAP_MS)) return undefined;
  const cpuByPid = new Map<number, number>();
  let peak = 0;
  for (const sample of selected) {
    peak = Math.max(peak, sample.rows.reduce((sum, row) => sum + row.rssBytes, 0));
    for (const row of sample.rows) {
      if (row.cpuTimeMs == null || row.cpuTimeMs < 0) continue;
      cpuByPid.set(row.pid, Math.max(cpuByPid.get(row.pid) ?? 0, row.cpuTimeMs));
    }
  }
  if (cpuByPid.size === 0 && peak <= 0) return undefined;
  return {
    attribution: "measured",
    ...(cpuByPid.size > 0 ? { cpuTimeMs: [...cpuByPid.values()].reduce((sum, value) => sum + value, 0) } : {}),
    ...(peak > 0 ? { peakRssBytes: peak } : {}),
    processCount: pids.size,
    sampleWindowMs: endedAt - startedAt,
  };
}
