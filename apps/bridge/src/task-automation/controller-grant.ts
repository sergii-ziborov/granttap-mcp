import type { ConfigSet } from "../../../../packages/protocol/schema";
import { readRawRecord, MAX_PENDING_AGE_MS } from "../approvals/state";
import { projectIdForSession } from "../config/runtime";
import { governedRevision } from "../policy/governed-projects";
import { grantTaskAutomation } from ".";

export type GrantRejection = "ambiguous_session" | "approval_unavailable" | "policy_changed";

/**
 * A request waits in the phone's list for as long as the person takes to open
 * it. Five minutes, the hook's own pending window, refused nearly every grant
 * made from the request's details; a still-pending request stays grantable.
 */
export const GRANT_PENDING_AGE_MS = 6 * 60 * 60_000;

/** Bind a controller's choice to the exact request and policy it displayed. */
export function applyControllerGrant(session: NonNullable<ConfigSet["autoAcceptSession"]>,
  now: number): GrantRejection | undefined {
  const mappedProject = projectIdForSession(session.sessionId);
  if (mappedProject === null) return "ambiguous_session";
  let projectId = mappedProject;
  // A hook that could not read the Project's revision leaves the request
  // unstamped, and the phone then shows and returns none. Refusing that as a
  // policy change made every grant from such a request fail; it binds to the
  // revision in force now, which still applies every Project rule.
  let unstamped = false;
  if (session.approvalRequestId) {
    const record = readRawRecord(session.approvalRequestId);
    if (!record || record.state !== "pending" || record.request.sessionId !== session.sessionId
      || now - record.updatedAt > Math.max(MAX_PENDING_AGE_MS, GRANT_PENDING_AGE_MS)) return "approval_unavailable";
    const request = record.request;
    if (projectId && request.projectId && projectId !== request.projectId) return "ambiguous_session";
    projectId ??= request.projectId;
    if (request.policyRevision !== session.expectedPolicyRevision) return "policy_changed";
    unstamped = request.policyRevision == null;
  }
  if (projectId) {
    const revision = governedRevision(projectId) ?? 0;
    if (!unstamped && ((revision > 0 && session.expectedPolicyRevision == null)
      || (session.expectedPolicyRevision != null && session.expectedPolicyRevision !== revision))) {
      return "policy_changed";
    }
    grantTaskAutomation(session.sessionId, projectId, revision, session.level);
  }
  return undefined;
}
