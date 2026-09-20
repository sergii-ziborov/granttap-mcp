export function sessionFromEnvironment(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return sessionBindingFromEnvironment(env).sessionId;
}

/** Claude's process env is a bootstrap id, not proof the current chat still owns it. */
export function sessionBindingFromEnvironment(env: NodeJS.ProcessEnv = process.env): {
  sessionId?: string;
  identity: "bound" | "unbound";
} {
  const id = env.CLAUDE_CODE_SESSION_ID?.trim() ?? "";
  if (/^[A-Za-z0-9._-]{8,128}$/.test(id)) return { sessionId: id, identity: "bound" };
  return { identity: "unbound" };
}
