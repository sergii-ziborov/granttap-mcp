import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { NativeUsageProvider } from "./projection";

type Options = {
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  keychain?: (service: string, account?: string) => Promise<string | undefined>;
  now?: number;
};

/** The same existing native entries used by Claude Code and Cursor. Never refresh or write credentials. */
export function readNativeKeychain(service: string, account?: string, run = execFile): Promise<string | undefined> {
  return new Promise(resolve => run("/usr/bin/security",
    ["find-generic-password", "-s", service, ...(account ? ["-a", account] : []), "-w"],
    { timeout: 3_000, maxBuffer: 65_536, windowsHide: true },
    (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined)));
}

async function jsonFile(path: string): Promise<any> {
  try {
    if ((await stat(path)).size > 65_536) return undefined;
    return JSON.parse(await readFile(path, "utf8"));
  } catch { return undefined; }
}

function token(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 32_768
    && !/[\r\n]/.test(value) ? value : undefined;
}

function claudeToken(value: any, now: number): string | undefined {
  const row = value?.claudeAiOauth;
  return typeof row?.expiresAt === "number" && row.expiresAt <= now ? undefined : token(row?.accessToken);
}

export async function readNativeCredential(provider: NativeUsageProvider, options: Options = {}): Promise<string | undefined> {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const keychain = options.keychain ?? readNativeKeychain;
  const keychainAllowed = options.keychain !== undefined || home === userInfo().homedir;
  if (provider === "grok") {
    const root = env.GRANTTAP_GROK_DIR ?? join(home, ".grok");
    const auth = await jsonFile(join(root, "auth.json"));
    return auth && Object.entries(auth).flatMap(([id, row]: [string, any]) =>
      id.startsWith("https://auth.x.ai::") && row?.auth_mode === "oidc" ? [token(row.key)] : [])
      .find(Boolean);
  }
  if (provider === "claude") {
    const override = env.GRANTTAP_CLAUDE_DIR ?? env.NODVOX_CLAUDE_DIR ?? env.CLAUDE_CONFIG_DIR;
    const saved = claudeToken(await jsonFile(join(override ?? join(home, ".claude"), ".credentials.json")), options.now ?? Date.now());
    if (saved || platform !== "darwin" || override || !keychainAllowed) return saved;
    if (!await jsonFile(join(home, ".claude", "settings.json"))) return undefined;
    try {
      const raw = await keychain("Claude Code-credentials");
      return raw ? claudeToken(JSON.parse(raw), options.now ?? Date.now()) : undefined;
    } catch { return undefined; }
  }
  const root = platform === "win32" ? join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Cursor")
    : platform === "darwin" ? join(home, ".cursor") : join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "cursor");
  const saved = token((await jsonFile(join(root, "auth.json")))?.accessToken);
  if (saved || platform !== "darwin" || !keychainAllowed || !await jsonFile(join(root, "cli-config.json"))) return saved;
  try { return token(await keychain("cursor-access-token", "cursor-user")); }
  catch { return undefined; }
}
