/** Provider cloud runners a computer can start for a Task: Claude Code cloud sessions and Codex Cloud tasks. */
import type { AgentIntegrationStatus } from "../../../../packages/protocol/schema";
import { resolveClaudeBinary } from "../providers/claude-bin";
import { resolveCodexBinary } from "../providers/codex-bin";
import { createCloudSupportCache, type CloudBinaries, type CloudRunnerSupport } from "./capability";
import { launchCloudRunner, runCloudCommand, type CloudLaunchInput, type CloudLaunchResult } from "./launch";

export type { CloudLaunchInput, CloudLaunchResult } from "./launch";
export type { CloudRunnerSupport } from "./capability";
export { cloudTaskPrompt } from "./launch";

const support = createCloudSupportCache();

function binaries(): CloudBinaries {
  return { claude: resolveClaudeBinary().path, codex: resolveCodexBinary() };
}

/** Integration rows say `cloud` only for an installed CLI whose help documents a headless cloud start. */
export function withCloudRunners(rows: AgentIntegrationStatus[],
  available: CloudRunnerSupport = support.current(binaries())): AgentIntegrationStatus[] {
  return rows.map(row => (row.agent === "claude" || row.agent === "codex") && row.installed && available[row.agent]
    ? { ...row, cloud: true } : row);
}

/** Launch with the CLI that answers on this computer now. */
export function startCloudRunner(input: CloudLaunchInput): Promise<CloudLaunchResult> {
  return launchCloudRunner(input, runCloudCommand, binaries());
}
