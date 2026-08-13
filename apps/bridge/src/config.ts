/** Public entry point for local bridge configuration and pairing. */
export * from "./config/capability-policy";
export * from "./config/pairing";
export * from "./config/paths";
export * from "./config/runtime";
export {
  classifyAction,
  isSafeReadonlyShell,
  shouldAutoAcceptCursorShell,
  shouldAutoAllow,
  type AutoAcceptLevel,
} from "./policy";
