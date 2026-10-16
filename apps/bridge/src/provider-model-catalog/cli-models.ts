import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AdvertisedModel } from "../../../../packages/protocol/schema";
import { resolveCursorAgentBin } from "../reply/process/cursor-agent-bin";
import { grokHome, resolveGrokBinary } from "../providers/grok-bin";
import { enrichGrokModels, readGrokModelDetails } from "./grok-cache";

const SIGNED_OUT = /not authenticated|please log in|login required/i;

export function parseCLIModels(output: string, provider: "cursor" | "grok", endpointId: string,
  now: number): AdvertisedModel[] {
  if (SIGNED_OUT.test(output)) return [];
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
  return clean.split("\n").flatMap(line => {
    const match = provider === "cursor"
      ? /^([a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159})\s+-\s+(.+)$/.exec(line.trim())
      : /^\s*[*-]\s+([a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159})(?:\s+\(([^)]+)\))?\s*$/.exec(line);
    return match ? [{ modelId: match[1]!, label: (provider === "cursor" ? match[2]! : match[1]!).slice(0, 160),
      provider, endpointId, observedAt: now, source: "advertised" as const }] : [];
  }).slice(0, 240).map((row, priority) => ({ ...row, priority }));
}

/**
 * Both native listings as picker rows. Grok's own account catalog names and
 * describes its listed models; when the listing could not run at all, that
 * fresh catalog stands in for it. A signed-out listing advertises nothing.
 */
export function cliModelRows(cursorOutput: string, grokOutput: string, grokRoot: string,
  endpointId: string, now: number): AdvertisedModel[] {
  const cursor = parseCLIModels(cursorOutput, "cursor", endpointId, now);
  let grok = parseCLIModels(grokOutput, "grok", endpointId, now);
  if (!grokOutput.trim()) {
    const cached = readGrokModelDetails(grokRoot, now);
    grok = cached ? [...cached.models.keys()].map(modelId => ({ modelId, label: modelId, provider: "grok" as const,
      endpointId, observedAt: cached.fetchedAt, source: "advertised" as const })) : [];
  }
  return [...cursor, ...enrichGrokModels(grok, grokRoot, now)];
}

let report: AdvertisedModel[] = [];
let checkedAt = 0;
let pending = false;
let scope = "";

function read(binary: string, args: string[]): Promise<string> {
  return new Promise(resolve => execFile(binary, args,
    { cwd: homedir(), timeout: 10_000, maxBuffer: 128_000, windowsHide: true },
    (error, stdout) => resolve(error ? "" : stdout)));
}

/** Only native listing commands; no prompt, session, login or auto-approval flags. */
export function cachedCLIModels(endpointId: string, env = process.env): AdvertisedModel[] {
  const currentScope = [homedir(), endpointId, env.GRANTTAP_CURSOR_AGENT_BIN,
    env.GRANTTAP_GROK_BIN, env.GRANTTAP_GROK_DIR].join("\u001f");
  if (scope !== currentScope) { scope = currentScope; report = []; checkedAt = 0; }
  if (!pending && Date.now() - checkedAt > 120_000) {
    checkedAt = Date.now();
    pending = true;
    const cursor = resolveCursorAgentBin(env);
    const grokRoot = grokHome(env);
    const grok = resolveGrokBinary(env);
    // Only an installed, signed-in Grok Build may stand in its cached catalog.
    const usable = existsSync(join(grokRoot, "auth.json")) && existsSync(grok);
    void Promise.all([
      existsSync(cursor) ? read(cursor, ["models"]) : "",
      usable ? read(grok, ["models"]) : "unavailable",
    ]).then(([a, b]) => {
      if (scope === currentScope) report = cliModelRows(a, b, grokRoot, endpointId, Date.now());
    }).finally(() => { pending = false; });
  }
  return report.filter(row => Date.now() - row.observedAt <= (row.provider === "grok" ? 24 * 60 : 5) * 60_000);
}
