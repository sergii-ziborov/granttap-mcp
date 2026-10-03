import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../config/runtime/paths";
import { writePrivateFile } from "../config/access/write-private";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export type AccountLink = { accountId: string; machineId: string; machineToken: string };

function valid(value: unknown): value is AccountLink {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<AccountLink>;
  return typeof row.accountId === "string" && UUID.test(row.accountId)
    && typeof row.machineId === "string" && UUID.test(row.machineId)
    && typeof row.machineToken === "string" && TOKEN.test(row.machineToken);
}

function path(): string { return join(configDir(), "account-link.json"); }

export function loadAccountLink(): AccountLink | null {
  try {
    const row = JSON.parse(readFileSync(path(), "utf8")) as unknown;
    return valid(row) ? row : null;
  } catch { return null; }
}

export function saveAccountLink(value: AccountLink): boolean {
  if (!valid(value)) return false;
  writePrivateFile(path(), `${JSON.stringify(value)}\n`);
  return true;
}
