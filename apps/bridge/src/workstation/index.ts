/**
 * How loaded this computer is and where its disk space went, for the phone and
 * for agents. The Engine measures with linked SweepLoom; without it the
 * operating system answers for load and `du` measures the agents' folders.
 * Nothing here deletes anything.
 */
import type { AgentDiskUsage, WorkstationSettings, WorkstationSnapshot, WorkstationSpace } from "../../../../packages/protocol/schema";
import { computerDisplayName } from "../../../../packages/core/computer-name";
import { workstationEngine, type WorkstationEngine } from "./engine";
import { homeDiskSpace, hostLoad } from "./load";
import { readAlerted, readSettings, readSpace, writeAlerted, writeSettings } from "./settings";
import { agentDiskFromSpace, scanSpace, spaceScanRunning, type ScanTrigger } from "./space";
import {
  automaticScanReason, hostBusy, lowSpaceAlert, lowSpaceLevel, lowSpaceMessage, onBatteryPower, startWatchLoop,
} from "./watch";

export { lowSpaceLevel } from "./watch";
export type { ScanTrigger } from "./space";

let engine: WorkstationEngine = workstationEngine();

/** For tests. */
export function useWorkstationEngine(next: WorkstationEngine): void { engine = next; }

export async function workstationSnapshot(): Promise<WorkstationSnapshot> {
  const load = await hostLoad(await engine.load());
  const space = readSpace();
  return {
    load, ...(space ? { space } : {}), scanning: spaceScanRunning(), fullScanSupported: engine.supported(),
    lowSpace: lowSpaceLevel(load.diskAvailableBytes), settings: readSettings(),
  };
}

/** Measure now. A person or agent asked, so the automatic setting does not apply. */
export function scanWorkstation(trigger: Extract<ScanTrigger, "manual" | "agent">): Promise<WorkstationSpace | undefined> {
  return scanSpace(trigger, engine);
}

export function setWorkstationSettings(settings: WorkstationSettings): void { writeSettings(settings); }

/** The load sheet's agent folders, from the last summary; re-read at most every half minute. */
export function agentDiskSampler(now: () => number = Date.now): (agents: readonly string[]) => Record<string, AgentDiskUsage> {
  let readAt = Number.NEGATIVE_INFINITY;
  let disk: Record<string, AgentDiskUsage> = {};
  return (agents) => {
    if (now() - readAt >= 30_000) { disk = agentDiskFromSpace(readSpace()); readAt = now(); }
    return Object.fromEntries(agents.flatMap((agent) => disk[agent] ? [[agent, disk[agent]!]] : []));
  };
}

type Phone = { send: (payload: { type: "agent.event"; text: string; kind: "status"; createdAt: number },
  to: "phone", options: { ttlMs: number; wake: boolean }) => Promise<unknown> };

/**
 * Starts the five-minute watch: low-space alerts and the smart automatic summary.
 * Every MCP server of this computer starts one; only the routing leader acts.
 */
export function startWorkstationWatch(input: { phone: () => Phone | undefined; leader: () => boolean },
  startedAt = Date.now()): () => void {
  const { phone } = input;
  return startWatchLoop({
    tick: async () => {
      if (!input.leader()) return;
      const disk = homeDiskSpace();
      if (!disk) return;
      const settings = readSettings();
      const alert = lowSpaceAlert(readAlerted(), disk.availableBytes);
      if (alert.send && settings.lowSpaceAlert) {
        const client = phone();
        // Not connected: the level stays untold and is sent on a later tick.
        if (!client) return;
        await client.send({ type: "agent.event", createdAt: Date.now(), kind: "status",
          text: lowSpaceMessage(alert.send, disk.availableBytes, computerDisplayName()) },
        "phone", { ttlMs: 6 * 3_600_000, wake: true });
      }
      writeAlerted(alert.alerted);
      if (spaceScanRunning()) return;
      const reason = await automaticScanReason(settings, readSpace(), startedAt,
        { availableBytes: disk.availableBytes, busy: hostBusy(), onBattery: () => onBatteryPower() }, Date.now());
      if (reason) await scanSpace(reason, engine);
    },
  });
}
