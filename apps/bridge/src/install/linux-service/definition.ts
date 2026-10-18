import { delimiter, dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";

export type LinuxJob = "http" | "monitor";
export const OWNER_MARKER = "# GrantTap owned per-user service v1";
export function linuxServiceName(job: LinuxJob): string { return `granttap-${job}.service`; }

function quoted(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("Invalid character in Linux service configuration");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

export function linuxServiceDefinition(job: LinuxJob, node: string, launcher: string, config: string, version = "0.0.0"): string {
  if (![node, launcher, config].every(isAbsolute)) throw new Error("Linux service paths must be absolute");
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid GrantTap service version");
  const path = [dirname(node), join(homedir(), ".local", "bin"), "/usr/local/bin", "/usr/bin", "/bin"].join(delimiter);
  return [OWNER_MARKER, "[Unit]", `Description=GrantTap ${version} ${job === "http" ? "local MCP authorization" : "computer sync"}`,
    "StartLimitIntervalSec=60", "StartLimitBurst=6", "", "[Service]", "Type=simple",
    // ':' disables environment expansion in ExecStart. '%' is escaped separately.
    `ExecStart=:${quoted(node)} ${quoted(launcher)} internal ${job === "http" ? "serve" : "monitor"}`,
    `WorkingDirectory=${quoted(dirname(dirname(launcher)))}`, `Environment=${quoted(`GRANTTAP_CONFIG_DIR=${config}`)}`,
    `Environment=${quoted(`PATH=${path}`)}`,
    `Environment=GRANTTAP_PACKAGE_VERSION=${version}`,
    ...(job === "monitor" ? ["Environment=GRANTTAP_MONITOR_PRIMARY=1"] : [
      "Environment=GRANTTAP_MCP_HTTP_HOST=127.0.0.1", "Environment=GRANTTAP_MCP_HTTP_PORT=17342"]),
    "UMask=0077", "Restart=on-failure", "RestartSec=5", "TimeoutStopSec=10", "KillMode=control-group",
    "", "[Install]", "WantedBy=default.target", ""].join("\n");
}

export function ownedLinuxService(contents: string, job: LinuxJob): boolean {
  return contents.startsWith(OWNER_MARKER + "\n")
    && /^ExecStart=:"[^\n]+" "[^\n]*granttap-mcp\.mjs" internal (serve|monitor)$/m.test(contents)
    && contents.includes(` internal ${job === "http" ? "serve" : "monitor"}\n`);
}
