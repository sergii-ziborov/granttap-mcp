import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { configDir, machineConfigPath } from "./config/paths";
import { writePrivateFile } from "./config/write-private";

export type InstanceEpochRecord = {
  epoch: string;
  mintedAt: number;
};

export function instanceEpochPath(): string {
  return join(configDir(), "instance-epoch.json");
}

function mint(): InstanceEpochRecord {
  return { epoch: randomBytes(16).toString("hex"), mintedAt: Date.now() };
}

function write(record: InstanceEpochRecord): InstanceEpochRecord {
  writePrivateFile(instanceEpochPath(), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

function read(): InstanceEpochRecord | undefined {
  try {
    const raw = JSON.parse(readFileSync(instanceEpochPath(), "utf8")) as Partial<InstanceEpochRecord>;
    if (typeof raw.epoch === "string" && raw.epoch.length >= 8 && typeof raw.mintedAt === "number") {
      return { epoch: raw.epoch, mintedAt: raw.mintedAt };
    }
  } catch {
    // Missing or damaged epoch is a new authority, not a silent reuse.
  }
  return undefined;
}

/**
 * One authority id for this helper process tree. Pairing keys without an
 * epoch file are treated as a restore/clone: a new epoch is minted so
 * commands issued against the previous instance cannot apply.
 */
export function loadInstanceEpoch(): InstanceEpochRecord {
  const existing = read();
  if (existing) return existing;
  return write(mint());
}

export function currentInstanceEpoch(): string {
  return loadInstanceEpoch().epoch;
}

export function remintInstanceEpoch(): InstanceEpochRecord {
  return write(mint());
}

export function pairingKeysPresent(): boolean {
  return existsSync(machineConfigPath());
}

/** After a snapshot restore that copied pairing keys but not this file. */
export function recoverInstanceAfterRestore(): InstanceEpochRecord {
  if (pairingKeysPresent() && !read()) return remintInstanceEpoch();
  return loadInstanceEpoch();
}

export function acceptInstanceEpoch(issued: string | undefined, requireFresh: boolean): boolean {
  if (!issued) return !requireFresh;
  return issued === currentInstanceEpoch();
}
