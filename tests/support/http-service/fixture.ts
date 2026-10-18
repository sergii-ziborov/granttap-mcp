import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";

function writeLaunchctl(path: string): void {
  writeFileSync(path, ["#!/bin/sh", 'case "$1" in', "  print)",
    '    test -f "$GRANTTAP_FAKE_PID_FILE" || exit 1',
    '    kill -0 "$(cat "$GRANTTAP_FAKE_PID_FILE")" 2>/dev/null', "    ;;", "  bootout)",
    '    if test -f "$GRANTTAP_FAKE_PID_FILE"; then',
    '      old_pid="$(cat "$GRANTTAP_FAKE_PID_FILE")"', '      kill -TERM "$old_pid" 2>/dev/null || true',
    "      count=0", '      while kill -0 "$old_pid" 2>/dev/null && test "$count" -lt 40; do',
    "        sleep 0.05", "        count=$((count + 1))", "      done",
    '      rm -f "$GRANTTAP_FAKE_PID_FILE"', "    fi", "    exit 0", "    ;;", "  bootstrap)",
    '    "$GRANTTAP_FAKE_NODE" "$GRANTTAP_FAKE_LAUNCHER" internal serve >>"$GRANTTAP_FAKE_LOG" 2>&1 &',
    '    echo $! >"$GRANTTAP_FAKE_PID_FILE"', "    exit 0", "    ;;", "esac", ""].join("\n"), { mode: 0o755 });
}

/** Real child service and temporary integration roots; no live LaunchAgent or provider root. */
export function createHttpServiceFixture(t: TestContext, root: string, port: number, executable: string) {
  const configDir = join(root, "config"), cursorDir = join(root, "cursor");
  const agentsDir = join(root, "LaunchAgents"), fakeBin = join(root, "bin"), pidFile = join(root, "http-service.pid");
  mkdirSync(configDir, { recursive: true }); mkdirSync(fakeBin, { recursive: true });
  const enginePath = join(root, "engine-fixture"), engineBytes = "#!/bin/sh\nexit 0\n";
  writeFileSync(enginePath, engineBytes, { mode: 0o700 });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ enginePath,
    engineSha256: createHash("sha256").update(engineBytes).digest("hex") }));
  writeLaunchctl(join(fakeBin, "launchctl"));
  const values = {
    GRANTTAP_CONFIG_DIR: configDir, GRANTTAP_CURSOR_DIR: cursorDir, GRANTTAP_LAUNCH_AGENTS_DIR: agentsDir,
    GRANTTAP_MCP_HTTP_HOST: "127.0.0.1", GRANTTAP_MCP_HTTP_PORT: String(port), GRANTTAP_NODE: process.execPath,
    GRANTTAP_TEST_FAKE_LAUNCHCTL: "1", PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    GRANTTAP_FAKE_PID_FILE: pidFile, GRANTTAP_FAKE_NODE: process.execPath,
    GRANTTAP_FAKE_LAUNCHER: executable, GRANTTAP_FAKE_LOG: join(root, "fake-service.log"),
    GRANTTAP_SKIP_LAUNCHCTL: undefined,
  };
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  const stopFakeService = async () => {
    try {
      const pid = Number(readFileSync(pidFile, "utf8"));
      if (!Number.isInteger(pid) || pid <= 1) return;
      process.kill(pid, "SIGTERM");
      for (let i = 0; i < 40; i++) { process.kill(pid, 0); await setTimeout(25); }
    }
    catch { /* Already stopped. */ }
  };
  t.after(stopFakeService);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { cursorDir, pidFile, stopFakeService };
}
