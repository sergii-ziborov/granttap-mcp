/** Public compatibility entry point for the optional Cursor HTTP OAuth service. */
export { httpMcpLaunchAgentPath } from "./http-service/common";
export {
  inspectHttpMcpService,
  restoreHttpMcpServiceAfterFailure,
  snapshotHttpMcpService,
  type HttpMcpServiceSnapshot,
  type HttpMcpServiceStatus,
} from "./http-service/snapshot";
export { installHttpMcpService } from "./http-service/installer";
export {
  isHttpMcpPortOccupied,
  probeHttpMcpHealth,
  waitForHttpMcpHealth,
} from "./http-service/health";
