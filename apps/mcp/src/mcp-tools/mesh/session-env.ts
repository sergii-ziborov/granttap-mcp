import { chatBinding, type ChatBinding } from "../../chat-identity";

/** The chat that started this MCP server, as its host names it; see `chat-identity`. */
export function sessionFromEnvironment(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return chatBinding(env).sessionId;
}

/** A host's id is a bootstrap identity for this server, not proof the current chat still owns it. */
export function sessionBindingFromEnvironment(env: NodeJS.ProcessEnv = process.env): ChatBinding {
  return chatBinding(env);
}
