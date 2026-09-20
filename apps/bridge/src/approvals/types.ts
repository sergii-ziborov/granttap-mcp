import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResolved,
} from "../../../../packages/protocol/schema";

export const MAX_RECORDS = 300;
export const MAX_PENDING_AGE_MS = 5 * 60_000;
export const TERMINAL_RETENTION_MS = 24 * 60 * 60_000;
export const UUID_V4_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
export const UUID_V4_RE = new RegExp(`^${UUID_V4_PATTERN}$`, "i");
export const FINGERPRINT_RE = /^[a-f0-9]{64}$/;
export const WINNER_NAME_RE = new RegExp(
  `^([a-f0-9]{32})(?:\\.(${UUID_V4_PATTERN}))?\\.winner$`,
  "i",
);
export const WINNER_CANDIDATE_RE = new RegExp(
  `^(([a-f0-9]{32})(?:\\.${UUID_V4_PATTERN})?\\.winner)\\.[0-9]+\\.${UUID_V4_PATTERN}\\.tmp$`,
  "i",
);

export type ApprovalRecord = {
  request: ApprovalRequest;
  state: "pending" | "resolved" | "cancelled" | "expired";
  updatedAt: number;
  generation?: string;
  fingerprint?: string;
  decision?: ApprovalDecision;
};

export type ApprovalTerminalState = "cancelled" | "expired";

export type ApprovalOutcome =
  | { kind: "decision"; decision: ApprovalDecision }
  | { kind: "terminal"; status: ApprovalTerminalState; resolved: ApprovalResolved };

export type ApprovalAcceptance = {
  matched: boolean;
  newlyResolved: boolean;
  request?: ApprovalRequest;
  outcome?: ApprovalOutcome;
  decision?: ApprovalDecision;
};

export type ApprovalRegistrationHandle = {
  requestId: string;
  sessionId?: string;
  generation: string | null;
  fingerprint: string;
};

export type ApprovalRegistration =
  | {
      matched: true;
      newlyRegistered: boolean;
      handle: ApprovalRegistrationHandle;
    }
  | {
      matched: false;
      newlyRegistered: false;
      reason: "conflicting_request";
    };

export type PendingApprovalRegistration = {
  request: ApprovalRequest;
  handle: ApprovalRegistrationHandle;
};

export type StoredApprovalWinner = {
  version: 1;
  requestId: string;
  sessionId?: string;
  generation: string | null;
  acceptedAt: number;
  outcome: ApprovalOutcome;
};
