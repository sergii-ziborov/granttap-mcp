import { dirname, isAbsolute } from "node:path";
import { shellCheckout } from "../../../support/repository-checkout";

/** Writes and explicit shell working directories are stronger evidence than session labels. */
export function claudeRepositoryPaths(line: any): string[] {
  if (line.message?.role !== "assistant" || !Array.isArray(line.message.content)) return [];
  return line.message.content.flatMap((block: any) => {
    if (block?.type !== "tool_use") return [];
    const input = block.input ?? {};
    if (["Write","Edit","MultiEdit"].includes(block.name) && typeof input.file_path === "string"
      && isAbsolute(input.file_path)) return [dirname(input.file_path)];
    if (block.name !== "Bash") return [];
    const path = shellCheckout(input.command) ?? input.cwd ?? input.workdir;
    return typeof path === "string" && isAbsolute(path) ? [path] : [];
  });
}
