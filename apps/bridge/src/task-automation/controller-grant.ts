import type { ConfigSet } from "../../../../packages/protocol/schema";
import { readRawRecord, MAX_PENDING_AGE_MS } from "../approvals/state";
import { projectIdForSession } from "../config/runtime";
import { governedRevision } from "../policy/governed-projects";
import { grantTaskAutomation } from ".";

export type GrantRejection = "ambiguous_session" | "approval_unavailable" | "policy_changed";

/** Bind a controller's choice to the exact request and policy it displayed. */
export function applyControllerGrant(session: NonNullable<ConfigSet["autoAcceptSession"]>,
  now: number): GrantRejection | undefined {
  const mappedProject = projectIdForSession(session.sessionId);
  if (mappedProject === null) return "ambiguous_session";
  let projectId = mappedProject;
  if (session.approvalRequestId) {
    const record = readRawRecord(session.approvalRequestId);
    if (!record || record.state !== "pending" || record.request.sessionId !== session.sessionId
      || now - record.updatedAt > MAX_PENDING_AGE_MS) return "approval_unavailable";
    const request = record.request;
    if (projectId && request.projectId && projectId !== request.projectId) return "ambiguous_session";
    projectId ??= request.projectId;
    if (request.policyRevision !== session.expectedPolicyRevision) return "policy_changed";
  }
  if (projectId) {
    const revision = governedRevision(projectId) ?? 0;
    if ((revision > 0 && session.expectedPolicyRevision == null)
      || (session.expectedPolicyRevision != null && session.expectedPolicyRevision !== revision)) {
      return "policy_changed";
    }
    grantTaskAutomation(session.sessionId, projectId, revision, session.level);
  }
  return undefined;
}
