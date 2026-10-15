import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AdvertisedModel } from "../../../../packages/protocol/schema";
import { resolveCursorAgentBin } from "../reply/process/cursor-agent-bin";

export function parseCLIModels(output: string, provider: "cursor" | "grok", endpointId: string,
  now: number): AdvertisedModel[] {
  if (/not authenticated|please log in|login required/i.test(output)) return [];
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
  return clean.split("\n").flatMap(line => {
    const match = provider === "cursor"
      ? /^([a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159})\s+-\s+(.+)$/.exec(line.trim())
      : /^\s*[*-]\s+([a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159})(?:\s+\(([^)]+)\))?\s*$/.exec(line);
    return match ? [{ modelId: match[1]!, label: (provider === "cursor" ? match[2]! : match[1]!).slice(0, 160),
      provider, endpointId, observedAt: now, source: "advertised" as const }] : [];
  }).slice(0, 240);
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
    const grokRoot = env.GRANTTAP_GROK_DIR ?? join(homedir(), ".grok");
    const grok = env.GRANTTAP_GROK_BIN ?? join(grokRoot, "bin/grok");
    void Promise.all([
      existsSync(cursor) ? read(cursor, ["models"]) : "",
      existsSync(join(grokRoot, "auth.json")) && existsSync(grok) ? read(grok, ["models"]) : "",
    ]).then(([a, b]) => {
      if (scope === currentScope) report = [...parseCLIModels(a, "cursor", endpointId, Date.now()),
        ...parseCLIModels(b, "grok", endpointId, Date.now())];
    }).finally(() => { pending = false; });
  }
  return report.filter(row => Date.now() - row.observedAt <= 5 * 60_000);
}
