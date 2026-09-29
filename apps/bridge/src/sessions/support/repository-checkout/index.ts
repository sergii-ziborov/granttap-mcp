import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

function gitRoot(path: string): string | undefined {
  try {
    return execFileSync("git", ["--no-optional-locks", "-C", path, "rev-parse", "--show-toplevel"],
      {encoding:"utf8", stdio:["ignore","pipe","ignore"], timeout:2_000}).trim() || undefined;
  } catch { return undefined; }
}

/** Recognize only a literal initial shell directory change, without evaluating shell code. */
export function shellCheckout(cmd: unknown): string | undefined {
  if (typeof cmd !== "string") return undefined;
  const token = '(?:"([^"$`]+)"|\'([^\']+)\'|([^\\s;&|$`]+))';
  const match = cmd.trim().match(new RegExp('^cd\\s+'+token+'\\s*(?:&&|;)'))
    ?? cmd.trim().match(new RegExp('^git\\s+-C\\s+'+token+'(?:\\s|$)'));
  const path = match?.[1] ?? match?.[2] ?? match?.[3];
  return path && isAbsolute(path) ? path : undefined;
}

/** Sustained, recent structured execution evidence can supersede the original checkout. */
export function observedCheckoutRoot(cwd: string, paths: string[]): string | undefined {
  if (paths.length < 3) return undefined;
  const counts = new Map<string,number>();
  const roots = new Map<string,string | undefined>();
  let relevant = 0;
  for (const path of paths.slice(-12)) {
    let resolved: string;
    try { resolved = realpathSync(path); } catch { continue; }
    relevant += 1;
    if (!roots.has(resolved)) roots.set(resolved,gitRoot(resolved));
    const root = roots.get(resolved);
    if (root) counts.set(root,(counts.get(root) ?? 0)+1);
  }
  const choices = [...counts].filter(([,count]) => count >= 3 && count/relevant >= 0.8);
  if (choices.length !== 1) return undefined;
  const root = choices[0]![0];
  return root === gitRoot(cwd) ? undefined : root;
}
