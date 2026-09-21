export {
  DEFAULT_ENGINE_POLICY_TIMEOUT_MS,
  ENGINE_PROTOCOL_VERSION,
  EngineProtocolError,
  EngineRemoteError,
  MAX_ENGINE_FRAME_BYTES,
  MAX_ENGINE_PENDING_REQUESTS,
} from "./transport/protocol-base";
export { EngineFrameDecoder, encodeEngineFrame } from "./transport/framing";
export { parseEngineResponse } from "./transport/result-parser";
export type {
  EngineContextCompilation,
  EngineContextEvidence,
  EngineOperation,
  EngineProject,
  EngineProjectBackbone,
  EngineProjectBinding,
  EngineRepositoryGraph,
  EngineRequest,
  EngineResult,
  EngineWireObject,
  ProjectBindingRole,
} from "./transport/protocol-types";
export type {
  InvocationEvent,
  InvocationHistoryPage,
  InvocationHistoryQuery,
  InvocationPhase,
  InvocationSource,
} from "./engine-invocation-protocol";
export type { KnowledgePage, KnowledgeRecord, KnowledgeRecordInput } from "./engine-memory-protocol";
export type {
  CapabilityFingerprint,
  CapabilityKind,
  EnforcementStatus,
  EnginePolicyDecision,
  FingerprintConfidence,
  PolicyEffect,
  PolicySource,
} from "./engine-policy-types";
