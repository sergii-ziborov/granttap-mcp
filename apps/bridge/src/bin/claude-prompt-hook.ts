#!/usr/bin/env -S npx tsx
/**
 * Claude Code UserPromptSubmit hook entry point.
 *
 * Registered in ~/.claude/settings.json so that when a person submits a
 * prompt, this program adds what the chat could not know by itself: the
 * background runs that answered phone messages in it, and the Mesh brief for
 * its Task. It never blocks a prompt — anything wrong, and it adds nothing.
 *
 *   Reads:  UserPromptSubmit JSON on stdin ({ session_id, prompt, cwd, ... })
 *   Writes: { hookSpecificOutput: { hookEventName, additionalContext } } on stdout
 */
import { promptContext } from "../mesh/prompt-context";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  // A background run answering the phone is itself a prompt submission; it is
  // not the live session the journal is kept for.
  if (process.env.GRANTTAP_DELIVERY) return;
  const raw = await readStdin();
  let input: { session_id?: unknown };
  try {
    input = JSON.parse(raw) as { session_id?: unknown };
  } catch {
    return;
  }
  const sessionId = typeof input.session_id === "string" ? input.session_id.trim() : "";
  const text = promptContext(sessionId);
  if (!text) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text },
  }));
}

main().catch(() => undefined).finally(() => process.exit(0));
