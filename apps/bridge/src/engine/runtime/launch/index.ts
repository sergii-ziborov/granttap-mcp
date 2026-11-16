import { join } from "node:path";
import { configDir } from "../../../config/runtime/paths";
import { engineSocketEndpoint } from "../../startup";

const MINIMUM_PARSER_STACK_BYTES = 32 * 1_024 * 1_024;

/** Native syntax parsing runs on Rust worker threads, outside the JS stack. */
export function engineLaunchEnvironment(
  env: NodeJS.ProcessEnv, socketPath: string, platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const requestedStack = Number(env.RUST_MIN_STACK);
  // The Engine keeps its search index of repository text in its own state folder beside the socket;
  // a person's own Weavatrix setting must not move it into their Weavatrix data.
  const { WEAVATRIX_SEARCH_HOME: _personalSearchHome, ...inherited } = env;
  return {
    ...inherited,
    GRANTTAP_ENGINE_SOCKET: engineSocketEndpoint(socketPath),
    // Rust's default worker stack aborts the daemon on ordinary long ASTs.
    // Scope this reserve to the verified Engine child; keep larger explicit reserves.
    RUST_MIN_STACK: String(Number.isSafeInteger(requestedStack)
      ? Math.max(MINIMUM_PARSER_STACK_BYTES, requestedStack) : MINIMUM_PARSER_STACK_BYTES),
    ...(platform === "win32" ? { GRANTTAP_ENGINE_STATE_DIR: join(configDir(), "engine", "state") } : {}),
  };
}
