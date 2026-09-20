import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OperationLedger, type OperationRecord } from "../operation-ledger";
import { OPERATION_CONFLICT, fromRecord, refused, type ToolAnswer } from "./answers";
import { registerNotifyTool } from "./notify";
import { registerQuestionTools } from "./questions";

export function registerInteractionTools(server: McpServer): void {
  const ledger = new OperationLedger();
  async function once(
    principal: string,
    tool: string,
    operation: string | undefined,
    digest: string,
    work: (previous: OperationRecord | undefined) => Promise<OperationRecord>,
  ): Promise<ToolAnswer> {
    if (!operation) return fromRecord(await work(undefined), false);
    const recalled = ledger.recall(principal, tool, operation, digest);
    if (recalled.kind === "conflict") return refused(OPERATION_CONFLICT);
    if (recalled.kind === "in_flight") return fromRecord(await recalled.result, true);
    if (recalled.kind === "replay" && recalled.record.pending !== "message") return fromRecord(recalled.record, true);
    const previous = recalled.kind === "replay" ? recalled.record : undefined;
    const record = await ledger.run(principal, tool, operation, () => work(previous));
    return fromRecord(record, previous != null);
  }
  registerNotifyTool(server, once);
  registerQuestionTools(server, once);
}
