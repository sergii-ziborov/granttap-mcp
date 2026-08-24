/**
 * A LaunchAgent is user-global: `launchctl bootstrap` replaces whatever job
 * already holds that label. A sandboxed run — a test, a probe, anything with a
 * temporary `HOME` or config directory — therefore evicts the real GrantTap
 * helper and installs a job whose plist, node modules, and log file vanish with
 * the temporary directory. launchd then keeps restarting a program it can no
 * longer load, which reads to the user as GrantTap crashing in a loop.
 *
 * A real installation always writes into the user's own Library. A plist under
 * the operating system's temporary directory is a sandbox by definition, so it
 * never reaches the live domain.
 */
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";

const TEMPORARY_ROOTS = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function insideTemporaryDirectory(path: string): boolean {
  if (process.env.GRANTTAP_TEST_FAKE_LAUNCHCTL === "1") return false;
  const target = canonical(path);
  const roots = new Set<string>();
  for (const root of [tmpdir(), ...TEMPORARY_ROOTS]) {
    roots.add(resolve(root));
    roots.add(canonical(root));
  }
  return [...roots].some((root) => target === root || target.startsWith(root + sep));
}

export const SANDBOXED_LAUNCH_AGENT_DETAIL =
  "refusing to load a LaunchAgent from a temporary directory; "
  + "a sandboxed run must not replace the installed GrantTap helper";

/**
 * Whether this plist may be handed to `launchctl` in the live user domain.
 *
 * `GRANTTAP_TEST_FAKE_LAUNCHCTL=1` states that the `launchctl` on PATH is a
 * stub, so the whole install path can be exercised without a live domain to
 * damage. It is an explicit, greppable opt-in; nothing in the shipped product
 * sets it.
 */
export function refusesLiveLaunchd(path: string): string | null {
  if (process.env.GRANTTAP_TEST_FAKE_LAUNCHCTL === "1") return null;
  return insideTemporaryDirectory(path) ? `${path}: ${SANDBOXED_LAUNCH_AGENT_DETAIL}` : null;
}
