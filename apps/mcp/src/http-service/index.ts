/** Public compatibility entry point for the optional Cursor HTTP OAuth service. */
export { httpMcpLaunchAgentPath } from "./common";
export {
  inspectHttpMcpService,
  restoreHttpMcpServiceAfterFailure,
  snapshotHttpMcpService,
  type HttpMcpServiceSnapshot,
  type HttpMcpServiceStatus,
} from "./snapshot";
export { installHttpMcpService } from "./installer";
export {
  isHttpMcpPortOccupied,
  probeHttpMcpHealth,
  waitForHttpMcpHealth,
} from "./health";
