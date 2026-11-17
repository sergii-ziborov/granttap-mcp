/**
 * `rm -rf` of a scratch folder a chat made under the system temp folder is ordinary work, not a
 * destructive action. Only plain commands qualify: every `rm` starts its own simple command, takes
 * only `-r`/`-R`/`-f`/`-v` flags, and names literal absolute paths whose real parent lies inside a
 * temp root. Shell expansion, globs, `..`, a trailing slash or the temp root itself make it ask again.
 */
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";

const SEPARATORS = /;|&&|\|\||\||&|\n|\(|\)/;
const UNSAFE = /[$`*?[\]{}~<>\\"]/;
const FLAG = /^-[rRfv]+$/;
const PATH = /^\/[A-Za-z0-9._@%+=:,/-]+$/;

function realOrSelf(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

function tempRoots(): string[] {
  const roots = ["/tmp", "/private/tmp", tmpdir()].map(realOrSelf).map(root => root.replace(/\/+$/, ""));
  return [...new Set(roots.filter(root => root.length > 1))];
}

/** The path's real parent must exist inside a temp root; the path itself must lie below it. */
function insideTemp(path: string, roots: string[]): boolean {
  if (!PATH.test(path) || path.endsWith("/")) return false;
  const parts = path.split("/").filter(Boolean);
  if (parts.some(part => part === "." || part === "..")) return false;
  let parent: string;
  try { parent = realpathSync(dirname(path)); } catch { return false; }
  return roots.some(root => parent === root || parent.startsWith(`${root}/`))
    && !roots.includes(realOrSelf(path));
}

function unquote(token: string): string | undefined {
  const quoted = /^'([^']*)'$/.exec(token);
  if (quoted) return quoted[1];
  return token.includes("'") ? undefined : token;
}

/** True when the command removes something and every removal is a literal path under a temp root. */
export function removesOnlyTempPaths(command: string): boolean {
  const roots = tempRoots();
  let removals = 0;
  for (const segment of command.split(SEPARATORS)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    const at = tokens.findIndex((token, index) => token === "rm" || token === "/bin/rm"
      || (token === "command" && tokens[index + 1] === "rm"));
    if (at === -1) continue;
    if (at !== 0) return false;
    if (UNSAFE.test(segment)) return false;
    const args = tokens.slice(tokens[0] === "command" ? 2 : 1).map(unquote);
    if (args.some(arg => arg === undefined)) return false;
    let paths = 0, literal = false;
    for (const arg of args as string[]) {
      if (!literal && arg === "--") { literal = true; continue; }
      if (!literal && arg.startsWith("-")) { if (!FLAG.test(arg)) return false; continue; }
      if (!insideTemp(arg, roots)) return false;
      paths += 1;
    }
    if (paths === 0) return false;
    removals += 1;
  }
  return removals > 0;
}
