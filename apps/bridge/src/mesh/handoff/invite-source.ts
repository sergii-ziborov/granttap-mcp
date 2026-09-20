import { readFileSync } from "node:fs";
import { stdin } from "node:process";

export type InviteSource =
  | { kind: "arg"; value: string }
  | { kind: "file"; path: string }
  | { kind: "stdin" }
  | { kind: "help" }
  | { kind: "error"; message: string };

export function parseInviteArgs(args: string[]): InviteSource {
  if (args.length === 0) return { kind: "error", message: "Usage: granttap mesh connect <invite | --file path | ->" };
  if (args.includes("--help") || args.includes("-h")) return { kind: "help" };
  if (args[0] === "-" && args.length === 1) return { kind: "stdin" };
  if (args[0] === "--file" && args[1]) return { kind: "file", path: args[1] };
  if (args.length === 1) return { kind: "arg", value: args[0]! };
  return { kind: "error", message: "Usage: granttap mesh connect <invite | --file path | ->" };
}

export function readInvite(source: InviteSource): string {
  if (source.kind === "arg") return source.value.trim();
  if (source.kind === "file") return readFileSync(source.path, "utf8").trim();
  if (source.kind === "stdin") return readFileSync(stdin.fd, "utf8").trim();
  throw new Error(source.kind === "error" ? source.message : "Usage: granttap mesh connect <invite | --file path | ->");
}
