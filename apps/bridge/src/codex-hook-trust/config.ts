import { ownedHookCommands } from "./projection";

export function codexHookSet(config: string): { permission: boolean; policy: boolean } {
  type Event = "PermissionRequest" | "PreToolUse";
  let event: Event | null = null;
  let matcherAll = false;
  let inCommandHook = false;
  let commandType = false;
  let command: string | null = null;
  let timeout: number | null = null;
  let permission = false;
  let policy = false;
  const finishCommandHook = () => {
    if (!event || !matcherAll || !inCommandHook || !commandType) return;
    if (event === "PermissionRequest"
      && timeout === 120
      && command === ownedHookCommands().permission) {
      permission = true;
    }
    if (event === "PreToolUse"
      && timeout === 30
      && command === ownedHookCommands().policy) {
      policy = true;
    }
  };
  for (const line of config.split(/\r?\n/)) {
    const parent = line.match(/^\s*\[\[hooks\.(PermissionRequest|PreToolUse)\]\]\s*(?:#.*)?$/i);
    if (parent) {
      finishCommandHook();
      event = parent[1]!.toLowerCase() === "permissionrequest"
        ? "PermissionRequest"
        : "PreToolUse";
      matcherAll = false;
      inCommandHook = false;
      commandType = false;
      command = null;
      timeout = null;
      continue;
    }
    const child = line.match(
      /^\s*\[\[hooks\.(PermissionRequest|PreToolUse)\.hooks\]\]\s*(?:#.*)?$/i,
    );
    if (child) {
      finishCommandHook();
      const childEvent: Event = child[1]!.toLowerCase() === "permissionrequest"
        ? "PermissionRequest"
        : "PreToolUse";
      inCommandHook = event === childEvent;
      commandType = false;
      command = null;
      timeout = null;
      continue;
    }
    if (/^\s*\[/.test(line)) {
      finishCommandHook();
      event = null;
      matcherAll = false;
      inCommandHook = false;
      commandType = false;
      command = null;
      timeout = null;
      continue;
    }
    if (event && !inCommandHook) {
      const matcher = line.match(/^\s*matcher\s*=\s*["'](.*)["']\s*(?:#.*)?$/i)?.[1];
      if (matcher != null) matcherAll = matcher.trim() === ".*";
    } else if (inCommandHook) {
      const type = line.match(/^\s*type\s*=\s*["'](.*)["']\s*(?:#.*)?$/i)?.[1];
      if (type != null) commandType = type.trim().toLowerCase() === "command";
      const value = line.match(/^\s*command\s*=\s*["'](.*)["']\s*(?:#.*)?$/i)?.[1];
      if (value != null) command = value;
      const rawTimeout = line.match(/^\s*timeout\s*=\s*(\d+)\s*(?:#.*)?$/i)?.[1];
      if (rawTimeout != null) timeout = Number(rawTimeout);
    }
  }
  finishCommandHook();
  return { permission, policy };
}

