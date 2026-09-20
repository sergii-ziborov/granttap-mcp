export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export function nativeAsk(message: string): void {
  process.stdout.write(JSON.stringify({
    permission: "ask",
    user_message: message,
    agent_message: message,
  }));
}

export function deny(message: string): void {
  process.stdout.write(JSON.stringify({
    permission: "deny", continue: false,
    user_message: message, agent_message: message,
    userMessage: message, agentMessage: message,
  }));
}
