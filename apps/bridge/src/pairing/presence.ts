import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "../config/runtime/paths";

type PresenceState = {
  phoneLastSeenAt?: number;
};

function presencePath(): string {
  return join(configDir(), "presence.json");
}

function readPresence(): PresenceState {
  try {
    const parsed = JSON.parse(readFileSync(presencePath(), "utf8")) as PresenceState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Last encrypted phone payload observed on this computer. No secrets. */
export function readPhoneLastSeenAt(): number | null {
  const at = readPresence().phoneLastSeenAt;
  return typeof at === "number" && Number.isFinite(at) ? at : null;
}

export function recordPhoneSeen(at = Date.now()): void {
  const path = presencePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...readPresence(), phoneLastSeenAt: at }));
  renameSync(tmp, path);
}

export function clearPhoneSeen(): void {
  try {
    unlinkSync(presencePath());
  } catch {
    /* nothing stored */
  }
}
