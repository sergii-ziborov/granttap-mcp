import { dirname, isAbsolute } from "node:path";
import { observedCheckoutRoot, repositoryRootOf, shellCheckout } from "../../../support/repository-checkout";

const FILE_EDITS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

function assistantTools(line: any): any[] {
  if (line.message?.role !== "assistant" || !Array.isArray(line.message.content)) return [];
  return line.message.content.filter((block: any) => block?.type === "tool_use");
}

function editedFile(input: any): unknown {
  return input.file_path ?? input.notebook_path;
}

/** Writes and explicit shell working directories are stronger evidence than session labels. */
export function claudeRepositoryPaths(line: any): string[] {
  return assistantTools(line).flatMap((block: any) => {
    const input = block.input ?? {};
    const file = editedFile(input);
    if (FILE_EDITS.includes(block.name) && typeof file === "string" && isAbsolute(file)) return [dirname(file)];
    if (block.name !== "Bash") return [];
    const path = shellCheckout(input.command) ?? input.cwd ?? input.workdir;
    return typeof path === "string" && isAbsolute(path) ? [path] : [];
  });
}

/** Paths the agent changed: edited files and folders it committed from. */
export function claudeChangedPaths(line: any): string[] {
  return assistantTools(line).flatMap((block: any) => {
    const input = block.input ?? {};
    const file = editedFile(input);
    if (FILE_EDITS.includes(block.name)) {
      return typeof file === "string" && isAbsolute(file) ? [dirname(file)] : [];
    }
    if (block.name !== "Bash" || !/\bgit\b[^;&|]*\bcommit\b/.test(String(input.command))) return [];
    const path = shellCheckout(input.command);
    return path ? [path] : [];
  });
}

/**
 * A chat launched inside a repository keeps the current-folder rule. One
 * launched from a parent folder such as `~/dev` belongs to the repository it
 * most recently changed, wherever its shell has wandered since.
 */
export function claudeCheckout(input: {
  launchCwd?: string;
  cwd: string;
  repositoryPaths: string[];
  changedPaths: string[];
}): string | undefined {
  if (input.launchCwd && !repositoryRootOf(input.launchCwd)) {
    for (const path of [...input.changedPaths].reverse()) {
      const root = repositoryRootOf(path);
      if (root) return root;
    }
  }
  return observedCheckoutRoot(input.cwd, input.repositoryPaths);
}
