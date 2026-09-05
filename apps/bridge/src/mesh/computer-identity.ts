/**
 * Which computer this is, whatever the network calls it today.
 *
 * The Mesh keyed a computer by its hostname, and a Mac renamed by the network
 * it joined — "Mac.lan" at home, "Serhiis-MacBook-Pro.local" on the road —
 * became a second computer with its own open executions and bindings. The
 * identity is written down once, on first use, as the name the computer had
 * then, and kept; every later name is remembered as a former name of the same
 * machine, so its leftovers can be retired. The current hostname stays what
 * people see.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { configDir } from "../config/paths";

export type ComputerIdentity = {
  computerId: string;
  /** Every hostname this computer has answered to, the current one included. */
  names: string[];
  createdAt: number;
};

const MAX_NAMES = 16;
let cached: { dir: string; identity: ComputerIdentity } | undefined;

function identityPath(dir: string): string {
  return join(dir, "computer.json");
}

function read(dir: string): ComputerIdentity | undefined {
  try {
    const parsed = JSON.parse(readFileSync(identityPath(dir), "utf8")) as Partial<ComputerIdentity>;
    if (typeof parsed.computerId !== "string" || !parsed.computerId.trim()) return undefined;
    const names = Array.isArray(parsed.names)
      ? parsed.names.filter((name): name is string => typeof name === "string" && name.trim().length > 0)
      : [];
    return {
      computerId: parsed.computerId.trim(),
      names: names.length ? names : [parsed.computerId.trim()],
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
    };
  } catch {
    return undefined;
  }
}

function write(dir: string, identity: ComputerIdentity): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(identityPath(dir), `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** This computer's identity, minted on first use and kept; the current name is added as it appears. */
export function computerIdentity(
  env: NodeJS.ProcessEnv = process.env,
  currentName: () => string = hostname,
  now: () => number = Date.now,
): ComputerIdentity {
  const override = env.GRANTTAP_COMPUTER_ID?.trim();
  const name = currentName().trim() || "computer";
  if (override) return { computerId: override, names: [name], createdAt: 0 };
  const dir = configDir();
  let identity = cached?.dir === dir ? cached.identity : read(dir);
  if (!identity) {
    identity = { computerId: name, names: [name], createdAt: now() };
    write(dir, identity);
  } else if (!identity.names.includes(name)) {
    identity = { ...identity, names: [...identity.names, name].slice(-MAX_NAMES) };
    write(dir, identity);
  }
  cached = { dir, identity };
  return identity;
}

/** The stable id the Mesh keys this computer by. */
export function computerId(env: NodeJS.ProcessEnv = process.env): string {
  return computerIdentity(env).computerId;
}

/** Names this computer used to go by, which the Mesh may still hold records under. */
export function formerComputerNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const identity = computerIdentity(env);
  return identity.names.filter((name) => name !== identity.computerId);
}

export function resetComputerIdentity(): void {
  cached = undefined;
}
