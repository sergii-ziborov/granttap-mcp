import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WorkstationSnapshot } from "../../../../../packages/protocol/schema";
import { scanWorkstation, workstationSnapshot } from "../../../../bridge/src/workstation";

const GIB = 1024 ** 3;
const gb = (bytes: number | undefined) => bytes == null ? "unknown" : `${(bytes / GIB).toFixed(1)} GB`;

/** One readable page: load first, then the largest groups and what in them is regenerable. */
export function describeWorkstation(snapshot: WorkstationSnapshot, now = Date.now()): string {
  const { load, space } = snapshot;
  const lines = [
    `Disk: ${gb(load.diskAvailableBytes)} free of ${gb(load.diskTotalBytes)} (${snapshot.lowSpace}).`,
    `Memory: ${gb(load.memoryUsedBytes)} used of ${gb(load.memoryTotalBytes)}; swap ${gb(load.swapUsedBytes)} of ${gb(load.swapTotalBytes)}; `
      + `CPU ${load.cpuPercent ?? "?"}% of ${load.logicalCores} cores.`,
    ...load.apps.map((app) => `- ${app.name ?? app.kind} (${app.kind}, ${app.processes} processes): ${gb(app.memoryBytes)}, ${app.cpuPercent}% CPU`),
  ];
  if (!space) lines.push("No space summary yet. Call again with scan: true to measure.");
  else {
    const minutes = Math.max(0, Math.round((now - space.scannedAt) / 60_000));
    lines.push(`Space summary ${minutes} min old (${space.trigger}${space.complete ? "" : ", stopped at its time budget"}`
      + `${space.source === "folders" ? ", agent folders only" : ""}):`);
    for (const group of space.groups) {
      lines.push(`${group.title}: ${gb(group.bytes)}, regenerable ${gb(group.regenerableBytes)}`);
      for (const item of group.items) lines.push(`  - ${item.path} ${gb(item.bytes)} [${item.kind}]`);
    }
  }
  lines.push("Only regenerable entries rebuild on their own. history is chat transcripts that GrantTap and the agents "
    + "read; protected is credentials and databases; never delete either. Nothing was deleted.");
  return lines.join("\n");
}

export function registerWorkstationTool(server: McpServer): void {
  server.registerTool("computer_load", {
    title: "How loaded this computer is and where its disk space went",
    description: "Read this computer's memory, swap, CPU, free disk and heaviest apps, plus the last summary of "
      + "where its disk space went: coding-agent folders (Claude Code, Claude Desktop, Codex, Cursor), simulators "
      + "and VM disks, package and build caches, and build output in the projects GrantTap knows. Each entry says "
      + "whether it is regenerable (cache, logs, build output), history (chat transcripts: keep them), protected "
      + "(credentials, databases) or user data. Use it before freeing disk space or when the computer is slow. "
      + "scan: true measures again now (about half a minute, up to three); otherwise the last summary is returned "
      + "with its age. It only reads; it deletes nothing.",
    inputSchema: {
      scan: z.boolean().optional().describe("Measure where the space went now instead of returning the last summary"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ scan }) => {
    if (scan) await scanWorkstation("agent");
    const snapshot = await workstationSnapshot();
    return {
      content: [{ type: "text" as const, text: describeWorkstation(snapshot) }],
      structuredContent: snapshot as unknown as Record<string, unknown>,
    };
  });
}
