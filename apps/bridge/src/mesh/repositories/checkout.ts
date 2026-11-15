/** A folder on this computer read as the Git checkout it belongs to. */
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import type { RepositoryFacts } from "../catalog";

export type InspectRepository = (cwd: string) => Promise<RepositoryFacts>;

export type CheckoutReading =
  | { ok: true; root: string; facts: RepositoryFacts }
  | { ok: false; reason: "not-found" | "not-a-repository" };

/** The real path of something that exists, or nothing. */
export async function existingPath(path: string): Promise<string | undefined> {
  if (!isAbsolute(path)) return undefined;
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

/**
 * The work-tree root a path lies in, by its real path, and what Git says of
 * it. A folder outside any work tree, or a file, is not a checkout.
 */
export async function readCheckout(path: string, inspect: InspectRepository): Promise<CheckoutReading> {
  const real = await existingPath(path);
  if (!real) return { ok: false, reason: "not-found" };
  try {
    if (!(await stat(real)).isDirectory()) return { ok: false, reason: "not-a-repository" };
  } catch {
    return { ok: false, reason: "not-found" };
  }
  const facts = await inspect(real);
  const root = facts.worktree ? await existingPath(facts.worktree) : undefined;
  if (!root) return { ok: false, reason: "not-a-repository" };
  return { ok: true, root, facts: root === facts.root ? facts : { ...facts, root, worktree: root } };
}

/** What a person calls a checkout: its folder's name. */
export function checkoutName(root: string): string {
  return (basename(root).trim() || "Repository").slice(0, 160);
}
