/**
 * One line in the monitor's log for each phone request it drops: one it cannot open, one this runtime
 * cannot read, one it could not answer. A drop used to leave no trace, so a phone that waited in vain
 * looked like a computer that had answered. Never a request's contents or keys; a line repeats at most
 * once a minute and then says how many it stood for.
 */
import { ZodError } from "zod";
import type { UnreadableFrame } from "../../../../../packages/core/relay-inbound";

const WHY: Record<UnreadableFrame["reason"], string> = {
  "no-key": "it is sealed for a chat this computer holds no key for",
  unopenable: "its chat's key does not open it",
  "wrong-scope": "it names another chat than the one it is sealed for",
  unknown: "this runtime cannot read it",
};
const KEPT = 64;

function reason(error: unknown): string {
  if (error instanceof ZodError) return "the answer does not fit the protocol";
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n", 1)[0]!.trim().slice(0, 120) || "an unnamed error";
}

export function droppedRequestLog(write: (line: string) => void = (line) => { process.stderr.write(line); },
  now: () => number = Date.now, spacingMs = 60_000) {
  const shown = new Map<string, { at: number; since: number }>();
  const note = (line: string): void => {
    const last = shown.get(line);
    if (last && now() - last.at < spacingMs) { last.since += 1; return; }
    shown.delete(line);
    shown.set(line, { at: now(), since: 0 });
    while (shown.size > KEPT) shown.delete(shown.keys().next().value!);
    write(`[monitor] ${line}${last?.since ? ` (${last.since} more like it since the last such line)` : ""}\n`);
  };
  return {
    unreadable: (frame: UnreadableFrame) => note(`dropped a phone ${frame.type ?? "request"}: ${WHY[frame.reason]}`),
    unanswered: (type: string, error: unknown) => note(`dropped a phone ${type} unanswered: ${reason(error)}`),
  };
}
