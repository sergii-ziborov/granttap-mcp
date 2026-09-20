/** Public entry point for local bridge configuration and pairing. */
export * from "./access/capability-policy";
export * from "./access/pairing";
export * from "./runtime/paths";
export * from "./runtime";
export {
  classifyAction,
  isSafeReadonlyShell,
  shouldAutoAcceptCursorShell,
  shouldAutoAllow,
  type AutoAcceptLevel,
} from "../policy";
