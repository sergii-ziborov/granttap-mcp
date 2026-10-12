import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generateTransferKey } from "../../../../../packages/core/crypto";
type SessionKeys = Record<string, string>;
const pause = new Int32Array(new SharedArrayBuffer(4));
export function loadSessionKeys(path: string): SessionKeys {
    if (!existsSync(path))
        return {};
    if (statSync(path).size > 8 * 1024 * 1024)
        throw Error("Task key store exceeds its private storage limit");
    let value: unknown;
    try {
        value = JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        throw Error("Task key store is unreadable");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw Error("Task key store is unreadable");
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [
        string,
        string
    ] => typeof entry[1] === "string" && entry[1].length >= 43 && entry[1].length <= 44));
}
/** Creation is serialized across local MCP processes; reads use atomic snapshots. */
export function persistedSessionKey(path: string, sessionId: string, waitMs = 5000): string {
    const existing = loadSessionKeys(path);
    if (Object.hasOwn(existing, sessionId))
        return existing[sessionId]!;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const lock = path + ".lock", deadline = Date.now() + waitMs;
    const owner = acquire(lock, deadline);
    try {
        const keys = loadSessionKeys(path);
        if (Object.hasOwn(keys, sessionId))
            return keys[sessionId]!;
        const key = generateTransferKey();
        const temporary = path + "." + process.pid + "." + randomUUID() + ".tmp";
        try {
            writeFileSync(temporary, JSON.stringify({ ...keys, [sessionId]: key }) + "\n", { mode: 0o600 });
            renameSync(temporary, path);
        }
        finally {
            try {
                unlinkSync(temporary);
            }
            catch { }
        }
        return key;
    }
    finally {
        unlinkSync(owner);
        rmdirSync(lock);
    }
}
function acquire(path: string, deadline: number): string {
    for (;;) {
        try {
            mkdirSync(path, { mode: 0o700 });
            const owner = path + "/owner-" + process.pid + "-" + randomUUID();
            writeFileSync(owner, "", { flag: "wx", mode: 0o600 });
            return owner;
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST")
                throw error;
            removeDeadOwner(path);
            if (Date.now() >= deadline)
                throw Error("Task key creation is busy; retry later");
            Atomics.wait(pause, 0, 0, 10);
        }
    }
}
function removeDeadOwner(path: string): void {
    try {
        const entries = readdirSync(path);
        if (entries.length === 0) {
            if (Date.now() - statSync(path).mtimeMs > 30000)
                rmdirSync(path);
            return;
        }
        if (entries.length !== 1)
            return;
        const owner = entries[0]!, match = /^owner-(\d+)-/.exec(owner);
        if (!match)
            return;
        const pid = Number(match[1]);
        if (!Number.isSafeInteger(pid) || pid <= 0)
            return;
        try {
            process.kill(pid, 0);
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") {
                unlinkSync(path + "/" + owner);
                rmdirSync(path);
            }
        }
    }
    catch { /* Another creator may already have released the lock. */ }
}
