import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { configDir, writePrivateFile } from "../../../config";

const execution = z.object({ sessionId: z.string().min(1).max(256), cwd: z.string().min(1).max(4_096),
  nativeSessionId: z.string().min(1).max(256) }).strict();
type Execution = z.infer<typeof execution>;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const root = () => join(configDir(), "cursor-executions");
const taskPath = (sessionId: string, cwd: string) => join(root(), "tasks", digest(JSON.stringify([sessionId, resolve(cwd)])) + ".json");
const nativePath = (nativeId: string) => join(root(), "native", digest(nativeId) + ".json");

function read(path: string): Execution | undefined {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8_192) throw new Error("Invalid Cursor execution mapping");
  return execution.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** IDE and ACP executions retain one GrantTap Task and computer policy scope. */
export function cursorExecution(sessionId: string, cwd: string): Execution | undefined {
  const saved = read(taskPath(sessionId, cwd));
  if (saved && (saved.sessionId !== sessionId || saved.cwd !== resolve(cwd))) throw new Error("Cursor execution workspace mismatch");
  return saved;
}

export function saveCursorExecution(value: Execution): void {
  const current = execution.parse({ ...value, cwd: resolve(value.cwd) });
  const previous = cursorExecution(current.sessionId, current.cwd);
  if (previous && previous.nativeSessionId !== current.nativeSessionId) throw new Error("Cursor Task already has an interactive execution");
  const alias = read(nativePath(current.nativeSessionId));
  if (alias && (alias.sessionId !== current.sessionId || alias.cwd !== current.cwd)) throw new Error("Cursor native execution already belongs to another Task");
  const contents = JSON.stringify(current) + "\n";
  writePrivateFile(taskPath(current.sessionId, current.cwd), contents);
  writePrivateFile(nativePath(current.nativeSessionId), contents);
}

export function cursorExecutionRootSessionId(nativeSessionId: string): string | undefined {
  const alias = read(nativePath(nativeSessionId));
  if (!alias || alias.nativeSessionId !== nativeSessionId) return;
  const saved = cursorExecution(alias.sessionId, alias.cwd);
  if (saved?.nativeSessionId !== nativeSessionId) throw new Error("Cursor execution alias has no matching Task");
  return saved.sessionId;
}
