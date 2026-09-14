import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { installHttpMcpService, probeHttpMcpHealth, waitForHttpMcpHealth } from "../apps/mcp/src/http-service";
import { inspectWindowsTask, windowsTaskName } from "../apps/bridge/src/windows-service";

test("Windows setup runs a persistent loopback OAuth service in the user's session", {
  skip: process.platform !== "win32",
}, async (t) => {
  const task = windowsTaskName("http");
  t.after(() => {
    if (!inspectWindowsTask("http").configured) return;
    spawnSync("schtasks.exe", ["/End", "/TN", task], { windowsHide: true });
    spawnSync("schtasks.exe", ["/Delete", "/TN", task, "/F"], { windowsHide: true });
  });
  const installed = installHttpMcpService();
  assert.notEqual(installed.status, "manual", installed.detail);
  assert.equal(inspectWindowsTask("http").configured, true);
  assert.equal(await waitForHttpMcpHealth(undefined, 15_000), true);
  assert.equal(await probeHttpMcpHealth(), true);
});
