import { runClaudeStatusLine } from "../../../provider-account-status/claude-statusline";

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk.toString();
    if (Buffer.byteLength(raw) > 64_000) return;
  }
  await runClaudeStatusLine(raw);
}
main().catch(() => undefined);
